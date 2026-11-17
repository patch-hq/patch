// The PTY runner (spec/02 § Terminal sessions — PTY sessions, § Host restarts).
//
// A real pseudo-terminal needs `openpty` plus a controlling-terminal handoff,
// which Node cannot do without a native module (node-pty) — and the host
// ships no native module for its terminal. Python's standard library can, and
// python3 is on every host the host runs on (the Linux box and the Mac).
//
// The runner is also what lets a terminal outlive the host. It is started
// detached (its own session, no stdio shared with the host), run as
// `python3 -c <script> <dir> <cols> <rows> <shell>`, and owns the shell and
// its PTY master for as long as the shell lives. Everything the shell prints
// goes to `<dir>/out.log` first, so a host that is not there loses nothing; the
// host talks to the runner over `<dir>/sock` (a unix socket), one line per
// message:
//
//   host -> runner   A <offset>     attach: send everything from this absolute
//                                   output offset, then stream live
//                    I <base64>     keystrokes, written to the PTY master
//                    R <cols> <rows>  set the window size (SIGWINCH)
//                    K              kill the shell's process group
//   runner -> host   O <start> <end>  the offset the following data starts at
//                                   (the requested one, or later if the log
//                                   was trimmed past it) and the offset the
//                                   log reached when the host attached: data
//                                   before <end> is replay, after it is live
//                    D <base64>     terminal output
//                    X <code>       the shell ended with this exit status
//
// One host is attached at a time; a new attach replaces the old one. The log
// is trimmed to its last 2 MiB once it passes 4 MiB, and offsets stay absolute
// (`<dir>/out.base` holds the offset of the log's first byte), so a host that
// asks for a trimmed-away offset is told where the log really starts.
//
// When the shell ends the runner writes `<dir>/exit.json` ({"code": n}), tells
// an attached host, and exits, leaving the log for a host that was away. A
// runner whose host has been gone for 30 minutes ends its shell, so an orphaned
// terminal does not live for ever. Anything the runner writes to fd 2 goes to
// `<dir>/err.log` and is surfaced, never hidden.
//
// The shell starts as a LOGIN shell: a phone's terminal is a remote login, like
// ssh, and a login shell reads the profile that puts the user's own tools (nvm,
// ~/.local/bin, Homebrew) on PATH.

export const PTY_HELPER_SOURCE = String.raw`
import os, sys, select, fcntl, termios, struct, signal, socket, base64, json, time

d, cols, rows, shell = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
ORPHAN_S = float(os.environ.get('PATCH_PTY_ORPHAN_S', '1800'))
LOG_MAX, LOG_KEEP = 4 * 1024 * 1024, 2 * 1024 * 1024

def winsize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

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

def append(data):
    global log, base, size
    os.lseek(log, 0, os.SEEK_END)
    os.write(log, data)
    size += len(data)
    if size > LOG_MAX:
        drop = size - LOG_KEEP
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

def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]

def handle(line):
    global client
    cmd, _, arg = line.partition(b' ')
    if cmd == b'A':
        attach(int(arg))
    elif cmd == b'I':
        write_all(master, base64.b64decode(arg))
    elif cmd == b'R':
        c, r = arg.split()
        winsize(master, int(c), int(r))
    elif cmd == b'K':
        kill_group(signal.SIGKILL)

while True:
    watch = [master, server] + ([client] if client is not None else [])
    ready, _, _ = select.select(watch, [], [], 1)
    if client is None and time.time() - detached_at > ORPHAN_S:
        kill_group(signal.SIGHUP)
        kill_group(signal.SIGKILL)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if not data:
            break
        append(data)
        send_data(data)
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
