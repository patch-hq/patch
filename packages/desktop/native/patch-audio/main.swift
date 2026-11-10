// patch-audio — the desktop shell's native audio helper (macOS 14.4+).
//
//   patch-audio tap        system audio → stdout, raw 16 kHz mono signed 16-bit PCM;
//                          prints `ready` on stderr once audio is flowing
//   patch-audio mic-watch  one JSON line per change: which processes have a mic open
//   patch-audio speakers   one JSON line per change: the text labels in a calling app's
//                          windows ({"labels": [...]}), read through macOS Accessibility,
//                          for the shell to pick participants and the active speaker from
//   patch-audio probe      creates a process tap and removes it again: exit 0 when System
//                          Audio Recording is allowed. The first run asks the user.
//
// Test sources (the synthetic meeting test, scripts/meeting-e2e). Each is chosen by an
// environment variable and replaces the real source for that command only; with none set
// nothing here runs:
//   PATCH_AUDIO_TAP_FILE=<wav>        `tap` plays a 16 kHz mono 16-bit WAV in real time, then
//                                     silence (as a quiet Mac does) instead of using Core Audio
//   PATCH_AUDIO_MIC_FEED=<file>       `mic-watch` prints each line appended to the file
//   PATCH_AUDIO_SPEAKERS_FEED=<file>  `speakers` prints each line appended to the file
// A bad file is a message on stderr and a non-zero exit, like every other failure.
//
// `tap` is a Core Audio process tap: audio only, no screen capture, so macOS shows
// no picker and no screen-sharing indicator. It follows the default output device
// (headphones in or out mid-call). `mic-watch` is how a meeting is noticed: a call
// app opening the microphone. NO FALLBACK: any failure is a message on stderr and a
// non-zero exit, which the shell surfaces.

import AVFoundation
import AudioToolbox
import ApplicationServices
import AppKit
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("patch-audio: \(message)\n".utf8))
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

let system = AudioObjectID(kAudioObjectSystemObject)

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

// MARK: - tap

final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "patch-audio.tap", qos: .userInteractive)
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    func start() {
        var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        check(AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &device), "read default output device")
        if device == AudioObjectID(kAudioObjectUnknown) { fail("no default output device") }

        addr = address(kAudioDevicePropertyDeviceUID)
        var uidRef: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        check(AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uidRef), "read output device UID")
        guard let outputUID = uidRef?.takeRetainedValue() as String? else { fail("no output device UID") }

        // Leave this helper's own process out; it makes no sound.
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Patch"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        check(AudioHardwareCreateProcessTap(description, &tapID), "create audio tap (is System Audio Recording allowed for Patch?)")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Patch Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "create aggregate device")

        var asbd = AudioStreamBasicDescription()
        size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        addr = address(kAudioTapPropertyFormat)
        check(AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd), "read tap format")
        guard let format = AVAudioFormat(streamDescription: &asbd),
              let converter = AVAudioConverter(from: format, to: target) else { fail("unsupported tap format") }

        let out = FileHandle.standardOutput
        check(
            AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [target] _, input, _, _, _ in
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / format.sampleRate) + 1024
                guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
                var consumed = false
                var error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return buffer
                }
                if let error { fail("convert audio: \(error.localizedDescription)") }
                guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
                out.write(Data(bytes: samples[0], count: Int(converted.frameLength) * 2))
            },
            "create audio callback"
        )
        check(AudioDeviceStart(aggregateID, procID), "start audio tap")
        FileHandle.standardError.write(Data("ready\n".utf8))
    }

    func stop() {
        if let procID, aggregateID != AudioObjectID(kAudioObjectUnknown) {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        if aggregateID != AudioObjectID(kAudioObjectUnknown) { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != AudioObjectID(kAudioObjectUnknown) { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

// MARK: - test sources

/// The PCM payload of a 16 kHz mono signed 16-bit WAV. Anything else is refused: a test
/// recording in the wrong format would otherwise play at the wrong speed and pass for a
/// transcription fault.
func readWavPcm(_ path: String) -> Data {
    guard let wav = FileManager.default.contents(atPath: path) else { fail("cannot read \(path)") }
    func u16(_ o: Int) -> Int { Int(wav[o]) | Int(wav[o + 1]) << 8 }
    func u32(_ o: Int) -> Int { u16(o) | u16(o + 2) << 16 }
    guard wav.count > 44, String(decoding: wav[0..<4], as: UTF8.self) == "RIFF",
          String(decoding: wav[8..<12], as: UTF8.self) == "WAVE" else { fail("\(path) is not a WAV file") }
    var offset = 12
    var formatOK = false
    while offset + 8 <= wav.count {
        let id = String(decoding: wav[offset..<offset + 4], as: UTF8.self)
        let size = u32(offset + 4)
        let body = offset + 8
        if id == "fmt " {
            formatOK = u16(body) == 1 && u16(body + 2) == 1 && u32(body + 4) == 16000 && u16(body + 14) == 16
        } else if id == "data" {
            if !formatOK { fail("\(path) must be 16 kHz mono signed 16-bit PCM") }
            return wav.subdata(in: body..<min(body + size, wav.count))
        }
        offset = body + size + (size % 2)
    }
    fail("\(path) has no audio data")
}

/// Plays `pcm` on stdout at real speed in 20 ms steps, then silence forever.
func runTapFile(_ path: String) -> Never {
    let pcm = readWavPcm(path)
    let step = 320 * 2 // 20 ms
    let silence = Data(count: step)
    let out = FileHandle.standardOutput
    FileHandle.standardError.write(Data("ready\n".utf8))
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { exit(0) }
        source.resume()
        signalSources.append(source)
    }
    let queue = DispatchQueue(label: "patch-audio.tap-file")
    queue.async {
        var position = 0
        let start = DispatchTime.now().uptimeNanoseconds
        var n: UInt64 = 0
        while true {
            if position < pcm.count {
                let end = min(position + step, pcm.count)
                var chunk = pcm.subdata(in: position..<end)
                if chunk.count < step { chunk.append(Data(count: step - chunk.count)) }
                out.write(chunk)
                position = end
            } else {
                out.write(silence)
            }
            n += 1
            let due = start + n * 20_000_000
            let now = DispatchTime.now().uptimeNanoseconds
            if due > now { Thread.sleep(forTimeInterval: Double(due - now) / 1e9) }
        }
    }
    dispatchMain()
}

/// Prints each line appended to `path`, as the real watchers print each change. Starts from
/// the beginning of the file, so lines written before the helper started are not lost.
func runFeed(_ path: String, initial: String) -> Never {
    FileHandle.standardOutput.write(Data((initial + "\n").utf8))
    var consumed = 0
    var pending = Data()
    while true {
        if let data = FileManager.default.contents(atPath: path), data.count > consumed {
            pending.append(data.subdata(in: consumed..<data.count))
            consumed = data.count
            while let nl = pending.firstIndex(of: 0x0A) {
                let line = pending.subdata(in: pending.startIndex..<nl)
                pending.removeSubrange(pending.startIndex...nl)
                if !line.isEmpty { FileHandle.standardOutput.write(line + Data("\n".utf8)) }
            }
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
}

func testSource(_ name: String) -> String? {
    guard let v = ProcessInfo.processInfo.environment[name], !v.isEmpty else { return nil }
    return v
}

func runTap() -> Never {
    if let file = testSource("PATCH_AUDIO_TAP_FILE") { runTapFile(file) }
    let tap = SystemTap()
    tap.start()

    // The tap clocks off the output device: rebuild it when the default changes.
    var changed = address(kAudioHardwarePropertyDefaultOutputDevice)
    AudioObjectAddPropertyListenerBlock(system, &changed, .main) { _, _ in
        tap.stop()
        tap.start()
    }

    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            tap.stop()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
    dispatchMain()
}

var signalSources: [DispatchSourceSignal] = []

// MARK: - mic-watch

struct MicProcess: Hashable {
    let pid: Int32
    let bundleId: String
}

/// An audio process can exit between being listed and being read. Core Audio then answers
/// kAudioHardwareBadObjectError ('!obj'): that process is simply gone, not a failure.
/// Every other error is still fatal.
enum ProcessRead<T> {
    case value(T)
    case gone
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> ProcessRead<UInt32> {
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var addr = address(selector)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    if status == kAudioHardwareBadObjectError { return .gone }
    check(status, "read audio process property")
    return .value(value)
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> ProcessRead<String?> {
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var addr = address(selector)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
    if status == kAudioHardwareBadObjectError { return .gone }
    check(status, "read audio process property")
    return .value(value?.takeRetainedValue() as String?)
}

func processesUsingMic() -> Set<MicProcess> {
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    check(AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size), "list audio processes")
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    check(AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &objects), "list audio processes")

    var found: Set<MicProcess> = []
    for object in objects {
        guard case .value(let running) = readUInt32(object, kAudioProcessPropertyIsRunningInput), running != 0,
              case .value(let id) = readString(object, kAudioProcessPropertyBundleID), let bundleId = id, !bundleId.isEmpty,
              case .value(let pid) = readUInt32(object, kAudioProcessPropertyPID)
        else { continue }
        found.insert(MicProcess(pid: Int32(truncatingIfNeeded: pid), bundleId: bundleId))
    }
    return found
}

func runMicWatch() -> Never {
    if let feed = testSource("PATCH_AUDIO_MIC_FEED") { runFeed(feed, initial: #"{"processes":[]}"#) }
    var last: Set<MicProcess>?
    while true {
        let now = processesUsingMic()
        if now != last {
            let list = now.sorted { $0.pid < $1.pid }.map { ["pid": Int($0.pid), "bundleId": $0.bundleId] as [String: Any] }
            let data = try! JSONSerialization.data(withJSONObject: ["processes": list], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data("\n".utf8))
            last = now
        }
        Thread.sleep(forTimeInterval: 1)
    }
}

// MARK: - speakers

/// Calling apps whose windows are read, matched by bundle-id prefix, so "com.microsoft.teams"
/// covers both classic Teams and the new Teams (com.microsoft.teams2). A browser covers Google Meet and the web Teams.
let speakerApps = [
    "us.zoom.xos", "com.microsoft.teams", "com.google.Chrome", "com.microsoft.edgemac",
    "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox", "com.apple.Safari",
]

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return [] }
    return value as? [AXUIElement] ?? []
}

/// Breadth-first, bounded: a browser's tree can be enormous.
func collectLabels(_ root: AXUIElement, into labels: inout Set<String>) {
    var queue = [root]
    var visited = 0
    while !queue.isEmpty && visited < 4000 {
        let element = queue.removeFirst()
        visited += 1
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
            if let text = axString(element, attribute as String), !text.isEmpty, text.count <= 160 { labels.insert(text) }
        }
        queue.append(contentsOf: axChildren(element))
    }
}

func speakerLabels() -> [String] {
    var labels: Set<String> = []
    for app in NSWorkspace.shared.runningApplications {
        guard let id = app.bundleIdentifier, speakerApps.contains(where: { id.hasPrefix($0) }) else { continue }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        // Chromium builds its web accessibility tree only when asked.
        AXUIElementSetAttributeValue(element, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        for window in axChildren(element) { collectLabels(window, into: &labels) }
    }
    return labels.sorted()
}

func runSpeakers() -> Never {
    if let feed = testSource("PATCH_AUDIO_SPEAKERS_FEED") { runFeed(feed, initial: #"{"labels":[]}"#) }
    if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
        fail("Accessibility is not allowed for Patch. Allow it in System Settings > Privacy & Security > Accessibility to name speakers")
    }
    var last: [String]?
    while true {
        let now = speakerLabels()
        if now != last {
            let data = try! JSONSerialization.data(withJSONObject: ["labels": now], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data("\n".utf8))
            last = now
        }
        Thread.sleep(forTimeInterval: 0.5)
    }
}

// MARK: - probe

/** macOS has no way to ask whether System Audio Recording is allowed without trying. */
func runProbe() -> Never {
    if testSource("PATCH_AUDIO_TAP_FILE") != nil { exit(0) }
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.uuid = UUID()
    description.name = "Patch probe"
    description.isPrivate = true
    var tapID = AudioObjectID(kAudioObjectUnknown)
    check(AudioHardwareCreateProcessTap(description, &tapID), "create audio tap (is System Audio Recording allowed for Patch?)")
    AudioHardwareDestroyProcessTap(tapID)
    exit(0)
}

// MARK: - main

switch CommandLine.arguments.dropFirst().first {
case "tap": runTap()
case "mic-watch": runMicWatch()
case "speakers": runSpeakers()
case "probe": runProbe()
default: fail("usage: patch-audio tap | mic-watch | speakers | probe")
}
