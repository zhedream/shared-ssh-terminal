using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

// OpenSSH invokes this only for local authentication questions. No credential
// is passed on the command line, in the environment, or in a temporary file.
public static class SharedSshAskpass {
    public static int Main(string[] args) {
        try {
            string pipeName = Environment.GetEnvironmentVariable("SST_ASKPASS_PIPE");
            string token = Environment.GetEnvironmentVariable("SST_ASKPASS_TOKEN");
            if (String.IsNullOrEmpty(pipeName) || String.IsNullOrEmpty(token)) return 1;
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut)) {
                pipe.Connect(5000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true)) {
                    writer.WriteLine(token + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(args.Length > 0 ? args[0] : "")));
                    writer.Flush();
                    string response = reader.ReadLine();
                    if (response == null || !response.StartsWith("ok:")) return 1;
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.WriteLine(Encoding.UTF8.GetString(Convert.FromBase64String(response.Substring(3))));
                    return 0;
                }
            }
        } catch { return 1; }
    }
}
