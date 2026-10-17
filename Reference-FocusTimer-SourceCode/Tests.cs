using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Studytime
{
    internal sealed class ManualClock : IStudyClock
    {
        public long Milliseconds { get; private set; }
        public DateTime UtcNow { get; private set; }
        public ManualClock() { UtcNow = DateTime.UtcNow; }
        public void Advance(long milliseconds) { Milliseconds += milliseconds; UtcNow = UtcNow.AddMilliseconds(milliseconds); }
    }
    internal sealed class MemoryStore : IStateStore
    {
        public AppData Data = new AppData();
        public bool Fail;
        public Action OnSave;
        public AppData Load() { return Copy(Data); }
        public void Save(AppData data)
        {
            if (Fail) throw new IOException("Simulated disk failure");
            Data = Copy(data);
            if (OnSave != null) OnSave();
        }
        public static AppData Copy(AppData value)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(AppData));
                serializer.WriteObject(stream, value); stream.Position = 0;
                return (AppData)serializer.ReadObject(stream);
            }
        }
    }
    internal static class Tests
    {
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
        private static readonly List<string> results = new List<string>();
        private static int failures;
        private static void Test(string title, Action test)
        {
            try { test(); results.Add("PASS  " + title); }
            catch (Exception e) { failures++; results.Add("FAIL  " + title + "\r\n" + e); }
        }
        private static void Equal<T>(T expected, T actual)
        {
            if (!Object.Equals(expected, actual)) throw new Exception("Expected " + expected + ", got " + actual);
        }
        private static void Throws(Action action)
        {
            try { action(); } catch { return; }
            throw new Exception("Expected an exception.");
        }
        public static int Run(string report)
        {
            string directory = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(report)), "test-data-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            Test("Initial state is idle and empty", delegate
            {
                SessionEngine engine = new SessionEngine(new MemoryStore(), new ManualClock());
                Equal(false, engine.Running); Equal(false, engine.Started); Equal(0L, engine.ElapsedMs); Equal(0, engine.Sessions.Count);
            });
            Test("Paused time is excluded across multiple resumes", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.Start(); clock.Advance(1250); engine.Pause(); clock.Advance(300000);
                Equal(1250L, engine.ElapsedMs); engine.Start(); clock.Advance(750); engine.Pause();
                Equal(2000L, engine.ElapsedMs); clock.Advance(600000); Equal(2000L, engine.ElapsedMs);
            });
            Test("Repeated start and pause are idempotent", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.Start(); clock.Advance(1000); engine.Start(); clock.Advance(1000); engine.Pause(); engine.Pause(); Equal(2000L, engine.ElapsedMs);
            });
            Test("Finish while running saves exactly one titled session", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.SetTitle("  Álgebra — Chapter 4  "); engine.Start(); clock.Advance(90000); StudySession session = engine.Finish();
                Equal("Álgebra — Chapter 4", session.Title); Equal(90000L, session.DurationMs); Equal(1, engine.Sessions.Count);
                Equal(false, engine.Running); Equal(false, engine.Started); Equal(0L, engine.ElapsedMs); Equal("", engine.Title);
                Throws(delegate { engine.Finish(); }); Equal(1, engine.Sessions.Count);
            });
            Test("Finishing a paused session excludes the subsequent break", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.Start(); clock.Advance(42000); engine.Pause(); clock.Advance(120000); Equal(42000L, engine.Finish().DurationMs);
            });
            Test("Blank titles receive a useful default", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.SetTitle("   "); engine.Start(); clock.Advance(100); Equal("Untitled session", engine.Finish().Title);
            });
            Test("A zero-length session cannot be finalized", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                Throws(delegate { engine.Finish(); }); engine.Start(); Throws(delegate { engine.Finish(); }); Equal(0, engine.Sessions.Count);
            });
            Test("Reset retains the title and existing history", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.Start(); clock.Advance(10000); engine.Finish(); engine.SetTitle("Physics"); engine.Start(); clock.Advance(25000); engine.Reset();
                Equal("Physics", engine.Title); Equal(1, engine.Sessions.Count); Equal(false, engine.Started); Equal(0L, engine.ElapsedMs);
            });
            Test("Closing pauses and restores without adding offline time", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                engine.SetTitle("Anatomy"); engine.Start(); clock.Advance(32000); engine.Close(); clock.Advance(86400000);
                SessionEngine restored = new SessionEngine(store, clock);
                Equal(true, restored.Restored); Equal(false, restored.Running); Equal(32000L, restored.ElapsedMs); Equal("Anatomy", restored.Title);
                restored.Start(); clock.Advance(3000); Equal(35000L, restored.Finish().DurationMs);
            });
            Test("Crash recovery restores the last checkpoint paused", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(11000); engine.Checkpoint(); Equal(true, store.Data.Current.Running); clock.Advance(100000);
                SessionEngine restored = new SessionEngine(store, clock); Equal(false, restored.Running); Equal(11000L, restored.ElapsedMs);
            });
            Test("Checkpoint disk latency does not lose running study time", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(10000); store.OnSave = delegate { clock.Advance(250); }; engine.Checkpoint(); Equal(10250L, engine.ElapsedMs);
                clock.Advance(1000); engine.Checkpoint(); Equal(11500L, engine.ElapsedMs);
            });
            Test("Failed finish retains the active session and adds no record", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(11000); store.Fail = true; Throws(delegate { engine.Finish(); });
                Equal(true, engine.Running); Equal(11000L, engine.ElapsedMs); Equal(0, engine.Sessions.Count);
                store.Fail = false; engine.Finish(); Equal(1, engine.Sessions.Count);
            });
            Test("Failed pause and reset preserve the in-memory stopwatch", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(3000); store.Fail = true; Throws(engine.Pause); Throws(engine.Reset); Equal(true, engine.Running); Equal(3000L, engine.ElapsedMs);
            });
            Test("Titles enforce their length limit", delegate
            {
                SessionEngine engine = new SessionEngine(new MemoryStore(), new ManualClock()); engine.SetTitle(new string('a', 120));
                Throws(delegate { engine.SetTitle(new string('a', 121)); }); Equal(120, engine.Title.Length);
            });
            Test("Deleting a session preserves other sessions", delegate
            {
                ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(new MemoryStore(), clock);
                engine.Start(); clock.Advance(1000); StudySession first = engine.Finish(); engine.Start(); clock.Advance(2000); StudySession second = engine.Finish();
                engine.Delete(first.Id); Equal(1, engine.Sessions.Count); Equal(second.Id, engine.Sessions[0].Id);
            });
            Test("Durations do not wrap after 24 hours", delegate { Equal("26:00:04", Format.Clock(26 * 3600000L + 4000)); Equal("< 1 sec", Format.Friendly(900)); });
            Test("CSV safely quotes titles and prevents spreadsheet formulas", delegate
            {
                StudySession session = new StudySession { Title = "=SUM(1,2) \"test\"", StartedUtc = DateTime.UtcNow.ToString("o"), FinishedUtc = DateTime.UtcNow.ToString("o"), DurationMs = 1250 };
                string csv = Format.Csv(new[] { session });
                Equal(true, csv.Contains("\"'=SUM(1,2) \"\"test\"\"\"")); Equal(true, csv.EndsWith(",1.250\r\n"));
            });
            Test("Atomic JSON storage persists Unicode titles and history", delegate
            {
                JsonStateStore store = new JsonStateStore(Path.Combine(directory, "roundtrip.json")); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                engine.SetTitle("日本語 · Cálculo 📚"); engine.Start(); clock.Advance(78500); engine.Finish();
                SessionEngine restored = new SessionEngine(new JsonStateStore(store.FilePath), clock); Equal(1, restored.Sessions.Count); Equal("日本語 · Cálculo 📚", restored.Sessions[0].Title); Equal(78500L, restored.Sessions[0].DurationMs);
                Equal(true, File.Exists(store.FilePath + ".bak")); Equal(0, Directory.GetFiles(directory, "*.tmp-*").Length);
            });
            Test("Corrupt data recovers a valid backup and preserves evidence", delegate
            {
                string path = Path.Combine(directory, "recovery.json"); JsonStateStore store = new JsonStateStore(path); AppData data = new AppData(); data.Current.Title = "Saved title"; store.Save(data);
                File.WriteAllText(path, "broken json"); JsonStateStore recovery = new JsonStateStore(path); AppData loaded = recovery.Load(); Equal(true, recovery.RecoveredBackup); Equal("Saved title", loaded.Current.Title);
                recovery.Save(loaded); Equal("Saved title", new JsonStateStore(path).Load().Current.Title); Equal(1, Directory.GetFiles(directory, "recovery.json.corrupt-*").Length);
                File.WriteAllText(path, "broken again"); Equal("Saved title", new JsonStateStore(path).Load().Current.Title);
            });
            Test("Unreadable data without a backup is never overwritten", delegate
            {
                string path = Path.Combine(directory, "unrecoverable.json"); File.WriteAllText(path, "original invalid data");
                Throws(delegate { new JsonStateStore(path).Load(); }); Equal("original invalid data", File.ReadAllText(path));
            });
            Test("Duplicate saved session IDs are rejected", delegate
            {
                AppData data = new AppData(); StudySession session = new StudySession { Title = "Test", StartedUtc = DateTime.UtcNow.ToString("o"), FinishedUtc = DateTime.UtcNow.ToString("o"), DurationMs = 1 };
                data.Sessions.Add(session); data.Sessions.Add(session); Throws(delegate { JsonStateStore.Validate(data); });
            });
            Test("Native buttons finish, reset, navigate and filter real sessions", delegate
            {
                ManualClock clock = new ManualClock(); MemoryStore store = new MemoryStore(); SessionEngine engine = new SessionEngine(store, clock);
                using (StudyForm form = new StudyForm(engine, true))
                {
                    form.SkipConfirmations = true; form.StartPosition = FormStartPosition.Manual; form.Location = new System.Drawing.Point(-30000, -30000); form.Opacity = 0; form.ShowInTaskbar = false; form.Show(); Application.DoEvents();
                    form.SetTitleForTest("Biology review"); form.StartButton.PerformClick(); Equal(true, engine.Running);
                    clock.Advance(65000); form.StartButton.PerformClick(); Equal(false, engine.Running); clock.Advance(50000); form.FinishButton.PerformClick();
                    Equal(1, engine.Sessions.Count); Equal(65000L, engine.Sessions[0].DurationMs); Equal("Biology review", engine.Sessions[0].Title);
                    form.ShowHistory(true); form.SearchForTest("biology"); Equal(1, form.FilteredCount); form.SearchForTest("calculus"); Equal(0, form.FilteredCount);
                    form.ShowHistory(false); form.StartButton.PerformClick(); clock.Advance(1000); form.StartButton.PerformClick(); form.ResetButton.PerformClick(); Equal(0L, engine.ElapsedMs); Equal(1, engine.Sessions.Count);
                    form.Close();
                }
            });
            Test("Existing version 1 records load with always-on-top disabled", delegate
            {
                string path = Path.Combine(directory, "legacy.json");
                File.WriteAllText(path, "{\"Version\":1,\"Current\":{\"Title\":\"Legacy title\",\"StartedUtc\":null,\"ElapsedMs\":0,\"Running\":false},\"Sessions\":[]}");
                SessionEngine engine = new SessionEngine(new JsonStateStore(path), new ManualClock());
                Equal(false, engine.AlwaysOnTop); Equal(false, engine.DarkMode); Equal("Legacy title", engine.Title);
            });
            Test("Pin preference survives restart, checkpoints, finish and reset", delegate
            {
                JsonStateStore store = new JsonStateStore(Path.Combine(directory, "pin.json")); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                engine.SetAlwaysOnTop(true); engine.SetTitle("Existing study"); engine.Start(); clock.Advance(12000); engine.Checkpoint();
                Equal(true, engine.AlwaysOnTop); engine.Finish(); engine.Reset(); engine.Close();
                SessionEngine restored = new SessionEngine(new JsonStateStore(store.FilePath), clock);
                Equal(true, restored.AlwaysOnTop); Equal(1, restored.Sessions.Count); Equal("Existing study", restored.Sessions[0].Title); Equal(12000L, restored.Sessions[0].DurationMs);
                restored.SetAlwaysOnTop(false); Equal(false, new SessionEngine(new JsonStateStore(store.FilePath), clock).AlwaysOnTop);
            });
            Test("A failed pin preference save preserves the timer and old setting", delegate
            {
                MemoryStore store = new MemoryStore(); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(43000); store.Fail = true; Throws(delegate { engine.SetAlwaysOnTop(true); });
                Equal(false, engine.AlwaysOnTop); Equal(true, engine.Running); Equal(43000L, engine.ElapsedMs);
            });
            Test("Native topmost flag toggles and compact resizing preserves controls", delegate
            {
                MemoryStore store = new MemoryStore(); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                using (StudyForm form = new StudyForm(engine, true))
                {
                    form.StartPosition = FormStartPosition.Manual; form.Location = new System.Drawing.Point(-30000, -30000); form.Opacity = 0; form.ShowInTaskbar = false; form.Show(); Application.DoEvents();
                    System.Drawing.Size original = form.Size;
                    Equal(false, form.TopMost); Equal(0, GetWindowLong(form.Handle, -20) & 8);
                    form.AlwaysOnTopButton.PerformClick(); Application.DoEvents(); Equal(true, form.TopMost); Equal(8, GetWindowLong(form.Handle, -20) & 8);
                    form.Size = form.MinimumSize; Application.DoEvents(); Equal(true, form.FloatingForTest); Equal(true, form.TimerControlsFitForTest); Equal(8, GetWindowLong(form.Handle, -20) & 8);
                    form.SetTitleForTest("Floating study"); form.StartButton.PerformClick(); clock.Advance(62000); form.StartButton.PerformClick(); clock.Advance(10000); form.FinishButton.PerformClick();
                    Equal(1, engine.Sessions.Count); Equal(62000L, engine.Sessions[0].DurationMs);
                    form.ShowHistory(true); form.SearchForTest("floating"); Equal(1, form.FilteredCount); form.ShowHistory(false);
                    form.Size = original; Application.DoEvents(); Equal(true, form.TimerControlsFitForTest); Equal(8, GetWindowLong(form.Handle, -20) & 8);
                    form.AlwaysOnTopButton.PerformClick(); Application.DoEvents(); Equal(false, form.TopMost); Equal(0, GetWindowLong(form.Handle, -20) & 8);
                    form.Close();
                }
            });
            Test("Dark preference persists through pinning, finishing and reopening", delegate
            {
                JsonStateStore store = new JsonStateStore(Path.Combine(directory, "appearance.json")); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                engine.SetDarkMode(true); engine.SetAlwaysOnTop(true); engine.SetTitle("Night study"); engine.Start(); clock.Advance(17000); engine.Checkpoint(); engine.Finish(); engine.Reset(); engine.Close();
                SessionEngine restored = new SessionEngine(new JsonStateStore(store.FilePath), clock);
                Equal(true, restored.DarkMode); Equal(true, restored.AlwaysOnTop); Equal(1, restored.Sessions.Count); Equal(17000L, restored.Sessions[0].DurationMs);
                restored.SetDarkMode(false); restored.Close(); Equal(false, new SessionEngine(new JsonStateStore(store.FilePath), clock).DarkMode);
            });
            Test("A failed dark-mode save preserves the existing preference and time", delegate
            {
                MemoryStore store = new MemoryStore(); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                engine.Start(); clock.Advance(29000); store.Fail = true; Throws(delegate { engine.SetDarkMode(true); });
                Equal(false, engine.DarkMode); Equal(true, engine.Running); Equal(29000L, engine.ElapsedMs);
            });
            Test("Native theme toggle and keyboard shortcut preserve sessions and pinning", delegate
            {
                MemoryStore store = new MemoryStore(); ManualClock clock = new ManualClock(); SessionEngine engine = new SessionEngine(store, clock);
                using (StudyForm form = new StudyForm(engine, true))
                {
                    form.StartPosition = FormStartPosition.Manual; form.Location = new System.Drawing.Point(-30000, -30000); form.Opacity = 0; form.ShowInTaskbar = false; form.Show(); Application.DoEvents();
                    System.Drawing.Size original = form.Size; System.Drawing.Color originalBackground = form.BackColor;
                    form.SetTitleForTest("Night biology"); form.StartButton.PerformClick(); clock.Advance(29000); form.AlwaysOnTopButton.PerformClick();
                    form.DarkModeButton.PerformClick(); Application.DoEvents(); Equal(true, engine.DarkMode); Equal(true, Theme.Dark); Equal(true, form.ThemeColorsMatchForTest);
                    Equal(false, originalBackground == form.BackColor); Equal(true, engine.Running); Equal(29000L, engine.ElapsedMs); Equal("Night biology", engine.Title); Equal(8, GetWindowLong(form.Handle, -20) & 8);
                    form.Size = form.MinimumSize; Application.DoEvents(); Equal(true, form.TimerControlsFitForTest); Equal(true, form.ThemeColorsMatchForTest);
                    form.StartButton.PerformClick(); form.FinishButton.PerformClick(); Equal(1, engine.Sessions.Count); Equal(29000L, engine.Sessions[0].DurationMs);
                    form.ShowHistory(true); form.SearchForTest("night"); Equal(1, form.FilteredCount); Equal(true, form.ThemeColorsMatchForTest);
                    form.ShortcutForTest(Keys.Control | Keys.Shift | Keys.D); Equal(false, engine.DarkMode); Equal(true, form.ThemeColorsMatchForTest); Equal(originalBackground, form.BackColor); Equal(1, form.FilteredCount);
                    form.Size = original; form.ShowHistory(false); Equal(true, form.TimerControlsFitForTest); Equal(8, GetWindowLong(form.Handle, -20) & 8);
                    form.Close();
                }
            });
            Test("Dark palette keeps text and primary buttons readable", delegate
            {
                bool wasDark = Theme.Dark;
                try
                {
                    Theme.SetDark(true);
                    Equal(true, Contrast(Theme.Ink, Theme.Surface) >= 4.5);
                    Equal(true, Contrast(Theme.Muted, Theme.Surface) >= 4.5);
                    Equal(true, Contrast(Theme.Ink, Theme.Background) >= 4.5);
                    Equal(true, Contrast(Theme.Green, Theme.Sidebar) >= 4.5);
                    Equal(true, Contrast(Theme.PrimaryInk, Theme.PrimaryBackground) >= 4.5);
                    Equal(true, Contrast(Theme.PrimaryInk, Theme.PrimaryHover) >= 4.5);
                }
                finally { Theme.SetDark(wasDark); }
            });
            Test("Dark history scrollbar scrolls records and preserves position on theme change", delegate
            {
                MemoryStore store = new MemoryStore();
                for (int i = 0; i < 12; i++) store.Data.Sessions.Add(new StudySession { Title = "History " + i, StartedUtc = DateTime.UtcNow.AddMinutes(-30).ToString("o"), FinishedUtc = DateTime.UtcNow.ToString("o"), DurationMs = 1800000 });
                SessionEngine engine = new SessionEngine(store, new ManualClock()); engine.SetDarkMode(true);
                using (StudyForm form = new StudyForm(engine, true))
                {
                    form.StartPosition = FormStartPosition.Manual; form.Location = new System.Drawing.Point(-30000, -30000); form.Opacity = 0; form.ShowInTaskbar = false; form.Show();
                    form.Size = form.MinimumSize; form.ShowHistory(true); Application.DoEvents();
                    Equal(true, form.DarkScrollVisibleForTest); Equal(90, form.ScrollHistoryForTest(90));
                    form.DarkModeButton.PerformClick(); Application.DoEvents(); Equal(false, form.DarkScrollVisibleForTest);
                    Equal(90, form.ScrollHistoryForTest(90)); Equal(12, form.FilteredCount);
                    form.Close();
                }
            });
            File.WriteAllText(report, String.Join("\r\n", results) + "\r\n\r\n" + (results.Count - failures) + "/" + results.Count + " tests passed.\r\n", new UTF8Encoding(false));
            return failures == 0 ? 0 : 1;
        }
        private static double Luminance(System.Drawing.Color color)
        {
            double[] channels = { color.R / 255.0, color.G / 255.0, color.B / 255.0 };
            for (int i = 0; i < 3; i++) channels[i] = channels[i] <= .04045 ? channels[i] / 12.92 : Math.Pow((channels[i] + .055) / 1.055, 2.4);
            return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        }
        private static double Contrast(System.Drawing.Color first, System.Drawing.Color second)
        {
            double a = Luminance(first), b = Luminance(second);
            return (Math.Max(a, b) + .05) / (Math.Min(a, b) + .05);
        }
    }
}
