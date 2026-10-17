using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Studytime
{
    [DataContract]
    public sealed class StudySession
    {
        [DataMember] public string Id = Guid.NewGuid().ToString();
        [DataMember] public string Title = "";
        [DataMember] public string StartedUtc;
        [DataMember] public string FinishedUtc;
        [DataMember] public long DurationMs;
        public DateTime FinishedLocal { get { return ParseDate(FinishedUtc).ToLocalTime(); } }
        public static DateTime ParseDate(string value)
        {
            return DateTime.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind).ToUniversalTime();
        }
    }

    [DataContract]
    public sealed class CurrentSession
    {
        [DataMember] public string Title = "";
        [DataMember] public string StartedUtc;
        [DataMember] public long ElapsedMs;
        [DataMember] public bool Running;
        public CurrentSession Copy()
        {
            return new CurrentSession { Title = Title, StartedUtc = StartedUtc, ElapsedMs = ElapsedMs, Running = Running };
        }
    }

    [DataContract]
    public sealed class AppData
    {
        [DataMember] public int Version = 1;
        [DataMember] public CurrentSession Current = new CurrentSession();
        [DataMember] public List<StudySession> Sessions = new List<StudySession>();
        [DataMember(EmitDefaultValue = false)] public bool AlwaysOnTop;
        [DataMember(EmitDefaultValue = false)] public bool DarkMode;
    }

    public interface IStudyClock { long Milliseconds { get; } DateTime UtcNow { get; } }
    public sealed class StudyClock : IStudyClock
    {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        public long Milliseconds { get { return clock.ElapsedMilliseconds; } }
        public DateTime UtcNow { get { return DateTime.UtcNow; } }
    }
    public interface IStateStore { AppData Load(); void Save(AppData data); }

    public sealed class JsonStateStore : IStateStore
    {
        public readonly string FilePath;
        public bool RecoveredBackup { get; private set; }
        private bool preserveBackupOnNextSave;
        public JsonStateStore(string filePath) { FilePath = Path.GetFullPath(filePath); }
        public AppData Load()
        {
            if (!File.Exists(FilePath))
            {
                if (!File.Exists(FilePath + ".bak")) return new AppData();
                RecoveredBackup = true;
                preserveBackupOnNextSave = true;
                return Read(FilePath + ".bak");
            }
            try { return Read(FilePath); }
            catch (Exception first)
            {
                if (!File.Exists(FilePath + ".bak"))
                    throw new IOException("Saved sessions could not be read. Your file has been kept unchanged at " + FilePath, first);
                try
                {
                    AppData recovered = Read(FilePath + ".bak");
                    File.Copy(FilePath, FilePath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff"), false);
                    RecoveredBackup = true;
                    preserveBackupOnNextSave = true;
                    return recovered;
                }
                catch (Exception backup)
                {
                    throw new IOException("Saved sessions and their backup could not be read. Both files have been kept unchanged at " + FilePath, backup);
                }
            }
        }
        private static AppData Read(string path)
        {
            AppData data;
            using (FileStream file = File.OpenRead(path))
                data = (AppData)new DataContractJsonSerializer(typeof(AppData)).ReadObject(file);
            Validate(data);
            return data;
        }
        public static void Validate(AppData data)
        {
            if (data == null || data.Version != 1 || data.Current == null || data.Sessions == null)
                throw new SerializationException("Unsupported or incomplete session data.");
            if (data.Current.Title == null || data.Current.Title.Length > 120 || data.Current.ElapsedMs < 0 || data.Current.ElapsedMs > 3155760000000L)
                throw new SerializationException("Invalid current session.");
            if (data.Current.StartedUtc != null) StudySession.ParseDate(data.Current.StartedUtc);
            if ((data.Current.ElapsedMs > 0 || data.Current.Running) && data.Current.StartedUtc == null)
                throw new SerializationException("Missing current session start date.");
            HashSet<string> ids = new HashSet<string>();
            foreach (StudySession session in data.Sessions)
            {
                Guid id;
                if (session == null || !Guid.TryParse(session.Id, out id) || !ids.Add(session.Id) ||
                    String.IsNullOrWhiteSpace(session.Title) || session.Title.Length > 120 ||
                    session.DurationMs <= 0 || session.DurationMs > 3155760000000L)
                    throw new SerializationException("Invalid saved session.");
                StudySession.ParseDate(session.StartedUtc);
                StudySession.ParseDate(session.FinishedUtc);
            }
        }
        public void Save(AppData data)
        {
            Validate(data);
            string directory = Path.GetDirectoryName(FilePath);
            Directory.CreateDirectory(directory);
            string temporary = FilePath + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    new DataContractJsonSerializer(typeof(AppData)).WriteObject(file, data);
                    file.Flush(true);
                }
                if (File.Exists(FilePath)) File.Replace(temporary, FilePath, preserveBackupOnNextSave ? null : FilePath + ".bak", true);
                else
                {
                    // Create the initial backup before committing, so no error after the
                    // primary commit can cause the caller to retry a successful operation.
                    if (!File.Exists(FilePath + ".bak")) File.Copy(temporary, FilePath + ".bak", false);
                    File.Move(temporary, FilePath);
                }
                preserveBackupOnNextSave = false;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    public sealed class SessionEngine
    {
        private readonly IStateStore store;
        private readonly IStudyClock clock;
        private AppData data;
        private long anchor;
        private long snapshotAnchor;
        public bool Restored { get; private set; }
        public bool Running { get { return data.Current.Running; } }
        public bool Started { get { return data.Current.StartedUtc != null; } }
        public string Title { get { return data.Current.Title; } }
        public bool AlwaysOnTop { get { return data.AlwaysOnTop; } }
        public bool DarkMode { get { return data.DarkMode; } }
        public long ElapsedMs { get { return data.Current.ElapsedMs + (Running ? Math.Max(0, clock.Milliseconds - anchor) : 0); } }
        public IList<StudySession> Sessions { get { return data.Sessions.AsReadOnly(); } }
        public SessionEngine(IStateStore store, IStudyClock clock)
        {
            this.store = store;
            this.clock = clock;
            data = store.Load();
            JsonStateStore.Validate(data);
            Restored = Started;
            data.Current.Running = false;
        }
        private AppData Snapshot()
        {
            CurrentSession current = data.Current.Copy();
            snapshotAnchor = clock.Milliseconds;
            current.ElapsedMs = data.Current.ElapsedMs + (Running ? Math.Max(0, snapshotAnchor - anchor) : 0);
            return new AppData { Current = current, Sessions = new List<StudySession>(data.Sessions), AlwaysOnTop = data.AlwaysOnTop, DarkMode = data.DarkMode };
        }
        private void Commit(AppData next)
        {
            store.Save(next);
            data = next;
            anchor = snapshotAnchor;
        }
        public void SetTitle(string title)
        {
            if (title == null || title.Length > 120) throw new ArgumentException("Titles may contain up to 120 characters.");
            data.Current.Title = title;
        }
        public void SetAlwaysOnTop(bool enabled)
        {
            AppData next = Snapshot();
            next.AlwaysOnTop = enabled;
            Commit(next);
        }
        public void SetDarkMode(bool enabled)
        {
            AppData next = Snapshot();
            next.DarkMode = enabled;
            Commit(next);
        }
        public void Start()
        {
            if (Running) return;
            AppData next = Snapshot();
            if (next.Current.StartedUtc == null) next.Current.StartedUtc = clock.UtcNow.ToString("o");
            next.Current.Running = true;
            Commit(next);
            Restored = false;
        }
        public void Pause()
        {
            if (!Running) return;
            AppData next = Snapshot();
            next.Current.Running = false;
            Commit(next);
        }
        public void Reset()
        {
            AppData next = Snapshot();
            next.Current = new CurrentSession { Title = data.Current.Title };
            Commit(next);
            Restored = false;
        }
        public StudySession Finish()
        {
            if (!Started || ElapsedMs <= 0) throw new InvalidOperationException("Start the timer before finishing a session.");
            AppData next = Snapshot();
            StudySession session = new StudySession
            {
                Title = String.IsNullOrWhiteSpace(Title) ? "Untitled session" : Title.Trim(),
                StartedUtc = next.Current.StartedUtc,
                FinishedUtc = clock.UtcNow.ToString("o"),
                DurationMs = next.Current.ElapsedMs
            };
            next.Sessions.Add(session);
            next.Current = new CurrentSession();
            Commit(next);
            Restored = false;
            return session;
        }
        public void Delete(string id)
        {
            AppData next = Snapshot();
            if (next.Sessions.RemoveAll(s => s.Id == id) > 0) Commit(next);
        }
        public void Checkpoint() { Commit(Snapshot()); }
        public void Close()
        {
            AppData next = Snapshot();
            next.Current.Running = false;
            Commit(next);
        }
    }

    public static class Format
    {
        public static string Clock(long milliseconds)
        {
            long seconds = Math.Max(0, milliseconds) / 1000;
            return String.Format(CultureInfo.InvariantCulture, "{0:00}:{1:00}:{2:00}", seconds / 3600, (seconds / 60) % 60, seconds % 60);
        }
        public static string Friendly(long milliseconds)
        {
            long seconds = Math.Max(0, milliseconds) / 1000;
            if (seconds == 0 && milliseconds > 0) return "< 1 sec";
            if (seconds < 60) return seconds + " sec";
            if (seconds < 3600) return (seconds / 60) + " min" + (seconds % 60 > 0 ? " " + seconds % 60 + " sec" : "");
            return (seconds / 3600) + " hr " + (seconds / 60) % 60 + " min";
        }
        private static string CsvCell(string value)
        {
            // Prevent spreadsheet software from interpreting user titles as formulas.
            if (value.Length > 0 && ("=+-@\t\r\n".IndexOf(value[0]) >= 0)) value = "'" + value;
            return "\"" + value.Replace("\"", "\"\"") + "\"";
        }
        public static string Csv(IEnumerable<StudySession> sessions)
        {
            StringBuilder csv = new StringBuilder("Title,Started (local),Finished (local),Effective time,Effective seconds\r\n");
            foreach (StudySession session in sessions.OrderByDescending(s => s.FinishedUtc))
            {
                csv.Append(CsvCell(session.Title)).Append(',')
                   .Append(CsvCell(StudySession.ParseDate(session.StartedUtc).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss zzz"))).Append(',')
                   .Append(CsvCell(session.FinishedLocal.ToString("yyyy-MM-dd HH:mm:ss zzz"))).Append(',')
                   .Append(CsvCell(Clock(session.DurationMs))).Append(',')
                   .Append((session.DurationMs / 1000.0).ToString("0.000", CultureInfo.InvariantCulture)).Append("\r\n");
            }
            return csv.ToString();
        }
    }
}
