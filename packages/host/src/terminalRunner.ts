// The terminal runner (spec/02 § Terminal sessions, § Host restarts).
//
// Every terminal session's shell runs under one of these, so a terminal
// outlives the host: the runner is started detached (its own session, no stdio
// shared with the host), run as
// `python3 -c <script> <dir> <cols> <rows> <shell> <mode>`, and owns the shell
// for as long as the shell lives. python3 is on every host the host runs on
// (the Linux box and the Mac), and it is also the only way to get a real
// pseudo-terminal without a native module: Node cannot do `openpty` plus a
// controlling-terminal handoff without node-pty.
//
// TWO MODES. `pty` gives the shell a pseudo-terminal (a phone drawing with an
// emulator) and starts it as a LOGIN shell: a phone's terminal is a remote
// login, like ssh, and a login shell reads the profile that puts the user's own
// tools (nvm, ~/.local/bin, Homebrew) on PATH. `pipe` gives it three plain
// pipes (the web drawer's line-at-a-time command box) and starts it as an
// ordinary shell, as a pipe shell always was.
//
// Everything the shell prints goes to `<dir>/out.log` first, so a host that is
// not there loses nothing. In `pty` mode the log is the raw terminal bytes. In
// `pipe` mode stdout and stderr have to stay apart, so the log is a run of
// records, each one byte naming the stream (`o` or `e`), a 4-byte big-endian
// length and that many bytes of output; the host decodes them. The host talks
// to the runner over `<dir>/sock` (a unix socket), one line per message:
//
//   host -> runner   A <offset>     attach: send everything from this absolute
//                                   output offset, then stream live
//                    I <base64>     input, written to the shell (the PTY master,
//                                   or the shell's stdin)
//                    R <cols> <rows>  set the window size (SIGWINCH; pty only)
//                    K              kill the shell's process group
//   runner -> host   O <start> <end>  the offset the following data starts at
//                                   (the requested one, or later if the log
//                                   was trimmed past it) and the offset the
//                                   log reached when the host attached: data
//                                   before <end> is replay, after it is live
//                    D <base64>     log bytes (in `pipe` mode, records)
//                    X <code>       the shell ended with this exit status
//
// One host is attached at a time; a new attach replaces the old one. The log
// is trimmed to its last 2 MiB once it passes 4 MiB (in `pipe` mode, at the
// next record boundary), and offsets stay absolute (`<dir>/out.base` holds the
// offset of the log's first byte), so a host that asks for a trimmed-away
// offset is told where the log really starts. The shell's pid is written to
// `<dir>/shell.pid`: a pipe session's interrupt signals the shell's children,
// which the host finds from it.
//
// When the shell ends the runner writes `<dir>/exit.json` ({"code": n}), tells
// an attached host, and exits, leaving the log for a host that was away. A
// runner whose host has been gone for 30 minutes ends its shell, so an orphaned
// terminal does not live for ever. A shell that cannot be found is refused
// before anything starts. Anything the runner writes to fd 2 goes to
// `<dir>/err.log` and is surfaced, never hidden.

export const TERMINAL_RUNNER_SOURCE = String.raw`
import os, sys, select, fcntl, termios, struct, signal, socket, base64, json, time, shutil

d, cols, rows, shell = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
mode = sys.argv[5] if len(sys.argv) > 5 else 'pty'
ORPHAN_S = float(os.environ.get('PATCH_PTY_ORPHAN_S', '1800'))
LOG_MAX, LOG_KEEP = 4 * 1024 * 1024, 2 * 1024 * 1024

if shutil.which(shell) is None:
    sys.stderr.write('shell not found: %s\n' % shell)
    sys.exit(2)

def winsize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

if mode == 'pty':
    master, slave = os.openpty()
    winsize(slave, cols, rows)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.execvp(shell, [shell, '-l'])
    os.close(slave)
    stdin_fd = master
    outs = {master: None}
else:
    in_r, in_w = os.pipe()
    out_r, out_w = os.pipe()
    err_r, err_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.dup2(in_r, 0)
        os.dup2(out_w, 1)
        os.dup2(err_w, 2)
        for fd in (in_r, in_w, out_r, out_w, err_r, err_w):
            if fd > 2:
                os.close(fd)
        os.execvp(shell, [shell])
    for fd in (in_r, out_w, err_w):
        os.close(fd)
    stdin_fd = in_w
    outs = {out_r: b'o', err_r: b'e'}

os.set_blocking(stdin_fd, False)
for fd in outs:
    os.set_blocking(fd, False)

with open(os.path.join(d, 'shell.pid.tmp'), 'w') as f:
    f.write(str(pid))
os.replace(os.path.join(d, 'shell.pid.tmp'), os.path.join(d, 'shell.pid'))

# A pipe shell's end is its exit, not its pipes closing (a background job can
# hold them open), so a SIGCHLD wakes the loop to reap it.
wake_r, wake_w = os.pipe()
os.set_blocking(wake_r, False)
os.set_blocking(wake_w, False)
signal.set_wakeup_fd(wake_w)
signal.signal(signal.SIGCHLD, lambda *_: None)

def kill_group(sig):
    try:
        os.killpg(pid, sig)
    except OSError:
        pass

def on_term(*_):
    kill_group(signal.SIGHUP)
    sys.exit(143)

signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGHUP, signal.SIG_IGN)

log = os.open(os.path.join(d, 'out.log'), os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
base = 0
size = 0

def write_base():
    tmp = os.path.join(d, 'out.base.tmp')
    with open(tmp, 'w') as f:
        f.write(str(base))
    os.replace(tmp, os.path.join(d, 'out.base'))

write_base()

def record_boundary(at):
    # The first record start at or after log position 'at' (pipe mode).
    if mode == 'pty':
        return at
    pos = 0
    while pos < at:
        os.lseek(log, pos, os.SEEK_SET)
        head = os.read(log, 5)
        pos += 5 + struct.unpack('>I', head[1:5])[0]
    return pos

def append(data):
    global log, base, size
    os.lseek(log, 0, os.SEEK_END)
    os.write(log, data)
    size += len(data)
    if size > LOG_MAX:
        drop = record_boundary(size - LOG_KEEP)
        os.lseek(log, drop, os.SEEK_SET)
        tail = b''
        while True:
            chunk = os.read(log, 1 << 20)
            if not chunk:
                break
            tail += chunk
        tmp = os.path.join(d, 'out.log.tmp')
        fd = os.open(tmp, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, tail)
        os.replace(tmp, os.path.join(d, 'out.log'))
        os.close(log)
        log = fd
        base += drop
        size = len(tail)
        write_base()

sock_path = os.path.join(d, 'sock')
try:
    os.unlink(sock_path)
except OSError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
# A relative name: a unix socket path is limited to ~104 bytes, and the runner
# is started with the terminal's directory as its working directory.
os.chdir(d)
server.bind('sock')
server.listen(1)

client = None
inbuf = b''
pending_in = b''
detached_at = time.time()

def send(line):
    global client
    if client is None:
        return
    try:
        client.settimeout(5)
        client.sendall(line)
        client.setblocking(False)
    except OSError:
        drop_client()

def drop_client():
    global client, inbuf, detached_at
    if client is not None:
        try:
            client.close()
        except OSError:
            pass
    client = None
    inbuf = b''
    detached_at = time.time()

def send_data(data):
    for i in range(0, len(data), 48 * 1024):
        send(b'D ' + base64.b64encode(data[i:i + 48 * 1024]) + b'\n')

def attach(offset):
    start = min(max(offset, base), base + size)
    send(('O %d %d\n' % (start, base + size)).encode())
    os.lseek(log, start - base, os.SEEK_SET)
    left = base + size - start
    while left > 0 and client is not None:
        chunk = os.read(log, min(left, 1 << 20))
        if not chunk:
            break
        left -= len(chunk)
        send_data(chunk)

def flush_input():
    # Input is queued and written as the shell takes it: a blocking write to a
    # shell that is busy printing would wedge the runner and the shell together.
    global pending_in
    while pending_in:
        try:
            n = os.write(stdin_fd, pending_in)
        except BlockingIOError:
            return
        except OSError:
            # The shell has gone (or closed its stdin): nothing will read this.
            pending_in = b''
            return
        pending_in = pending_in[n:]

def handle(line):
    global pending_in
    cmd, _, arg = line.partition(b' ')
    if cmd == b'A':
        attach(int(arg))
    elif cmd == b'I':
        pending_in += base64.b64decode(arg)
        flush_input()
    elif cmd == b'R':
        if mode == 'pty':
            c, r = arg.split()
            winsize(master, int(c), int(r))
    elif cmd == b'K':
        kill_group(signal.SIGKILL)

def output(fd, data):
    tag = outs[fd]
    if tag is not None:
        data = tag + struct.pack('>I', len(data)) + data
    append(data)
    send_data(data)

def read_out(fd):
    # Returns False at the end of that stream.
    try:
        data = os.read(fd, 65536)
    except BlockingIOError:
        return True
    except OSError:
        data = b''
    if not data:
        return False
    output(fd, data)
    return True

status = None
while True:
    watch = list(outs) + [server, wake_r] + ([client] if client is not None else [])
    ready, writable, _ = select.select(watch, [stdin_fd] if pending_in else [], [], 1)
    if client is None and time.time() - detached_at > ORPHAN_S:
        kill_group(signal.SIGHUP)
        kill_group(signal.SIGKILL)
    if writable:
        flush_input()
    ended = False
    for fd in list(outs):
        if fd in ready and not read_out(fd):
            if mode == 'pty':
                ended = True
            else:
                del outs[fd]
                os.close(fd)
    if ended:
        break
    if wake_r in ready:
        try:
            while os.read(wake_r, 512):
                pass
        except OSError:
            pass
    if mode == 'pipe':
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
            # Whatever the shell printed before it exited is still in the pipes.
            for fd in list(outs):
                while True:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    output(fd, data)
            break
    if server in ready:
        conn, _ = server.accept()
        drop_client()
        conn.setblocking(False)
        client = conn
    if client is not None and client in ready:
        try:
            data = client.recv(65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            drop_client()
        elif data:
            inbuf += data
            while b'\n' in inbuf and client is not None:
                line, inbuf = inbuf.split(b'\n', 1)
                handle(line)

if status is None:
    _, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
code = code if code >= 0 else 128 - code
with open('exit.json.tmp', 'w') as f:
    json.dump({'code': code}, f)
os.replace('exit.json.tmp', 'exit.json')
send(('X %d\n' % code).encode())
try:
    os.unlink('sock')
except OSError:
    pass
sys.exit(0)
`;
