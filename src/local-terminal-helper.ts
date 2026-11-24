// Compiled into the instance runtime directory on first use. Kept in the
// TypeScript distribution so the npm package needs no extra native payload.
export const localTerminalHelper = String.raw`
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class TerminalJob
{
    const uint Suspended = 4, KillOnClose = 0x2000, Infinite = 0xffffffff;
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint Faults, Total, Active, Terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedLength;
        public IntPtr ReservedBytes, StdIn, StdOut, StdErr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    delegate bool ControlHandler(uint type);
    static readonly ControlHandler Control = type => type == 0 || type == 1;
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static int Main(string[] args)
    {
        if (args.Length < 2 || args.Length > 3) return 125;
        var child = new ProcessInfo();
        IntPtr job = IntPtr.Zero;
        try {
            using (var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut, PipeOptions.Asynchronous)) {
                pipe.Connect(5000);
                var input = new byte[1];
                var stop = pipe.BeginRead(input, 0, 1, null, null);
                using (var stopSignal = stop.AsyncWaitHandle) {
                    if (stop.IsCompleted || !SetConsoleCtrlHandler(Control, true)) return 125;
                    job = CreateJobObject(IntPtr.Zero, null);
                    if (job == IntPtr.Zero) return 125;
                    var limits = new ExtendedLimits();
                    limits.Basic.Flags = KillOnClose;
                    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return 125;

                    string shell = args[1];
                    var command = new StringBuilder("\"" + shell + "\" -NoLogo -NoProfile");
                    if (args.Length == 3) command.Append(" -EncodedCommand ").Append(args[2]);
                    var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)) };
                    if (!CreateProcess(shell, command, IntPtr.Zero, IntPtr.Zero, false, Suspended, IntPtr.Zero, null, ref startup, out child)) return 125;
                    // Never permit an untracked process to execute user code.
                    if (!AssignProcessToJobObject(job, child.Process)) {
                        TerminateProcess(child.Process, 125);
                        WaitForSingleObject(child.Process, Infinite);
                        return 125;
                    }
                    if (stop.IsCompleted || ResumeThread(child.Thread) == Infinite) return 125;
                    byte[] ready = Encoding.ASCII.GetBytes("READY\n");
                    pipe.Write(ready, 0, ready.Length);
                    pipe.Flush();

                    for (;;) {
                        Accounting accounting;
                        if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return 125;
                        if (accounting.Active == 0) {
                            uint code;
                            return GetExitCodeProcess(child.Process, out code) ? unchecked((int)code) : 125;
                        }
                        if (stopSignal.WaitOne(50)) {
                            // The broker either sent a stop byte or its pipe closed.
                            if (!TerminateJobObject(job, 130)) return 125;
                            for (;;) {
                                if (!QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return 125;
                                if (accounting.Active == 0) return 130;
                                Thread.Sleep(25);
                            }
                        }
                    }
                }
            }
        } catch { return 125; }
        finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        }
    }
}
`;
