using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Studytime")]
[assembly: AssemblyDescription("An offline stopwatch for effective study time.")]
[assembly: AssemblyProduct("Studytime")]
[assembly: AssemblyCompany("Studytime")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

namespace Studytime
{
    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 2 && args[0] == "--self-test") return Tests.Run(args[1]);
            if (args.Length == 2 && args[0] == "--render-preview") return Preview.Render(args[1]);
            bool created;
            using (Mutex single = new Mutex(true, "Local\\StudytimeDesktop-v1", out created))
            {
                if (!created)
                {
                    foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Application.ExecutablePath)))
                    {
                        if (process.Id != Process.GetCurrentProcess().Id && process.MainWindowHandle != IntPtr.Zero)
                        { ShowWindow(process.MainWindowHandle, 9); SetForegroundWindow(process.MainWindowHandle); return 0; }
                    }
                    MessageBox.Show("Studytime is already running. Look for it in your taskbar.", "Studytime", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return 0;
                }
                try
                {
                    string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Studytime", "sessions.json");
                    JsonStateStore store = new JsonStateStore(path);
                    SessionEngine engine = new SessionEngine(store, new StudyClock());
                    if (store.RecoveredBackup)
                        MessageBox.Show("Your session file needed recovery. Studytime restored the last valid backup and preserved the original file.\n\nPlease check your session history.", "Session data recovered", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    using (StudyForm form = new StudyForm(engine, false)) Application.Run(form);
                    return 0;
                }
                catch (Exception e)
                {
                    MessageBox.Show("Studytime could not open.\n\n" + e.Message, "Studytime", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally { single.ReleaseMutex(); }
            }
        }
    }

    internal static class Preview
    {
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr hdc, uint flags);
        private static void HideOffscreen(StudyForm form)
        {
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-30000, -30000);
            form.ShowInTaskbar = false;
            form.Opacity = 0;
            form.Show();
            Application.DoEvents();
        }
        private static void Save(StudyForm form, string path)
        {
            form.Refresh(); Application.DoEvents();
            using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
            {
                bool rendered;
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    IntPtr hdc = graphics.GetHdc();
                    try { rendered = PrintWindow(form.Handle, hdc, 0); }
                    finally { graphics.ReleaseHdc(hdc); }
                }
                if (!rendered) form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
                bitmap.Save(path, ImageFormat.Png);
            }
        }
        public static int Render(string directory)
        {
            try
            {
                Directory.CreateDirectory(directory);
                using (StudyForm ready = new StudyForm(new SessionEngine(new MemoryStore(), new ManualClock()), true))
                { HideOffscreen(ready); Save(ready, Path.Combine(directory, "01-ready.png")); }
                ManualClock clock = new ManualClock();
                MemoryStore store = new MemoryStore();
                string[] titles = { "Biology · cellular respiration", "Calculus practice problems", "Read: The Republic", "History · lecture notes", "Spanish vocabulary", "Chemistry review", "Biology · Chapter 03", "Statistics: probability" };
                for (int i = 0; i < titles.Length; i++)
                {
                    DateTime end = clock.UtcNow.AddDays(-i / 2).AddHours(-i - 1);
                    store.Data.Sessions.Add(new StudySession { Title = titles[i], StartedUtc = end.AddMinutes(-38 - i * 4).ToString("o"), FinishedUtc = end.ToString("o"), DurationMs = (38 + i * 4) * 60000L + i * 21000 });
                }
                SessionEngine engine = new SessionEngine(store, clock);
                engine.SetTitle("Biology · Chapter 04"); engine.Start(); clock.Advance(13 * 60000 + 52000);
                using (StudyForm form = new StudyForm(engine, true))
                {
                    HideOffscreen(form); Size fullSize = form.Size; Save(form, Path.Combine(directory, "02-studying.png"));
                    form.ShowHistory(true); Save(form, Path.Combine(directory, "03-history.png"));
                    form.SearchForTest("no such session"); Save(form, Path.Combine(directory, "04-search-empty.png"));
                    form.ShowHistory(false); form.Size = form.MinimumSize; Save(form, Path.Combine(directory, "05-compact.png"));
                    form.AlwaysOnTopButton.PerformClick(); Save(form, Path.Combine(directory, "06-pinned.png"));
                    form.ShowHistory(true); form.SearchForTest(""); Save(form, Path.Combine(directory, "07-compact-history.png"));
                    form.DarkModeButton.PerformClick(); Save(form, Path.Combine(directory, "08-dark-compact-history.png"));
                    form.ShowHistory(false); Save(form, Path.Combine(directory, "09-dark-compact.png"));
                    form.Size = fullSize; Save(form, Path.Combine(directory, "10-dark-full.png"));
                    form.ShowHistory(true); Save(form, Path.Combine(directory, "11-dark-history.png"));
                }
                return 0;
            }
            catch (Exception e) { File.WriteAllText(Path.Combine(directory, "preview-error.txt"), e.ToString()); return 1; }
        }
    }
}
