using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Studytime
{
    internal static class Theme
    {
        public static bool Dark { get; private set; }
        public static void SetDark(bool dark) { Dark = dark; }
        public static Color Background { get { return Dark ? Color.FromArgb(21, 28, 24) : Color.FromArgb(246, 246, 242); } }
        public static Color Sidebar { get { return Dark ? Color.FromArgb(17, 24, 20) : Color.FromArgb(236, 239, 232); } }
        public static Color Surface { get { return Dark ? Color.FromArgb(32, 42, 36) : Color.White; } }
        public static Color Ink { get { return Dark ? Color.FromArgb(232, 240, 235) : Color.FromArgb(32, 49, 40); } }
        public static Color Muted { get { return Dark ? Color.FromArgb(167, 182, 173) : Color.FromArgb(111, 125, 116); } }
        public static Color Green { get { return Dark ? Color.FromArgb(156, 212, 179) : Color.FromArgb(52, 99, 77); } }
        public static Color Pale { get { return Dark ? Color.FromArgb(41, 61, 50) : Color.FromArgb(230, 239, 231); } }
        public static Color Line { get { return Dark ? Color.FromArgb(53, 70, 59) : Color.FromArgb(226, 232, 225); } }
        public static Color Selected { get { return Dark ? Color.FromArgb(48, 74, 58) : Color.FromArgb(216, 229, 216); } }
        public static Color PrimaryBackground { get { return Dark ? Color.FromArgb(54, 101, 76) : Green; } }
        public static Color PrimaryHover { get { return Dark ? Color.FromArgb(68, 123, 93) : Color.FromArgb(40, 82, 62); } }
        public static Color PrimaryInk { get { return Color.White; } }
        public static Color DisabledInk { get { return Dark ? Color.FromArgb(113, 132, 120) : Color.FromArgb(164, 175, 167); } }
        public static Font Font(float size, FontStyle style) { return new Font("Segoe UI", size, style); }
        public static GraphicsPath Round(RectangleF r, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
        public static void Box(Graphics g, Rectangle r, Color color, float radius)
        {
            using (GraphicsPath path = Round(r, radius))
            using (SolidBrush brush = new SolidBrush(color)) g.FillPath(brush, path);
        }
        public static void Text(Graphics g, string text, Font font, Color color, Rectangle r, TextFormatFlags alignment)
        {
            TextRenderer.DrawText(g, text, font, r, color, alignment | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        }
        public static void Symbol(Graphics g, string symbol, Rectangle r, Color color)
        {
            float k = Math.Min(r.Width, r.Height) / 24f;
            float x = r.X + (r.Width - 24 * k) / 2, y = r.Y + (r.Height - 24 * k) / 2;
            using (Pen p = new Pen(color, 1.7f * k))
            using (SolidBrush b = new SolidBrush(color))
            {
                p.StartCap = p.EndCap = LineCap.Round;
                if (symbol == "play") g.FillPolygon(b, new[] { new PointF(x + 8*k, y + 5*k), new PointF(x + 19*k, y + 12*k), new PointF(x + 8*k, y + 19*k) });
                if (symbol == "pause") { g.FillRectangle(b, x + 7*k, y + 5*k, 3.3f*k, 14*k); g.FillRectangle(b, x + 14*k, y + 5*k, 3.3f*k, 14*k); }
                if (symbol == "check") g.DrawLines(p, new[] { new PointF(x + 5*k, y + 12*k), new PointF(x + 10*k, y + 17*k), new PointF(x + 19*k, y + 7*k) });
                if (symbol == "clock") { g.DrawEllipse(p, x + 3*k, y + 3*k, 18*k, 18*k); g.DrawLines(p, new[] { new PointF(x + 12*k, y + 7*k), new PointF(x + 12*k, y + 12*k), new PointF(x + 16*k, y + 14*k) }); }
                if (symbol == "reset") { g.DrawArc(p, x + 4*k, y + 4*k, 16*k, 16*k, 215, 295); g.DrawLines(p, new[] { new PointF(x + 3*k, y + 4*k), new PointF(x + 3*k, y + 10*k), new PointF(x + 9*k, y + 10*k) }); }
                if (symbol == "history") { g.DrawRectangle(p, x + 5*k, y + 3*k, 14*k, 18*k); for (int i = 0; i < 3; i++) g.DrawLine(p, x + 9*k, y + (8 + 4*i)*k, x + 15*k, y + (8 + 4*i)*k); }
                if (symbol == "export") { g.DrawLines(p, new[] { new PointF(x + 12*k, y + 3*k), new PointF(x + 12*k, y + 15*k) }); g.DrawLines(p, new[] { new PointF(x + 8*k, y + 11*k), new PointF(x + 12*k, y + 15*k), new PointF(x + 16*k, y + 11*k) }); g.DrawLines(p, new[] { new PointF(x + 4*k, y + 15*k), new PointF(x + 4*k, y + 21*k), new PointF(x + 20*k, y + 21*k), new PointF(x + 20*k, y + 15*k) }); }
                if (symbol == "trash") { g.DrawLine(p, x + 5*k, y + 6*k, x + 19*k, y + 6*k); g.DrawRectangle(p, x + 9*k, y + 3*k, 6*k, 3*k); g.DrawLines(p, new[] { new PointF(x + 7*k, y + 8*k), new PointF(x + 8*k, y + 21*k), new PointF(x + 16*k, y + 21*k), new PointF(x + 17*k, y + 8*k) }); g.DrawLine(p, x + 11*k, y + 10*k, x + 11*k, y + 17*k); g.DrawLine(p, x + 14*k, y + 10*k, x + 14*k, y + 17*k); }
                if (symbol == "arrow") { g.DrawLine(p, x + 4*k, y + 12*k, x + 20*k, y + 12*k); g.DrawLines(p, new[] { new PointF(x + 15*k, y + 7*k), new PointF(x + 20*k, y + 12*k), new PointF(x + 15*k, y + 17*k) }); }
                if (symbol == "pin") { g.DrawLines(p, new[] { new PointF(x + 8*k, y + 3*k), new PointF(x + 16*k, y + 3*k), new PointF(x + 15*k, y + 10*k), new PointF(x + 19*k, y + 14*k), new PointF(x + 5*k, y + 14*k), new PointF(x + 9*k, y + 10*k), new PointF(x + 8*k, y + 3*k) }); g.DrawLine(p, x + 12*k, y + 14*k, x + 12*k, y + 22*k); }
                if (symbol == "moon") { using (GraphicsPath moon = new GraphicsPath()) { moon.AddArc(x + 4*k, y + 3*k, 17*k, 17*k, 65, 275); moon.AddBezier(x + 20.5f*k, y + 8.6f*k, x + 9*k, y + 13*k, x + 7*k, y + 7*k, x + 11.1f*k, y + 3.1f*k); g.DrawPath(p, moon); } }
                if (symbol == "sun") { g.DrawEllipse(p, x + 7*k, y + 7*k, 10*k, 10*k); for (int i = 0; i < 8; i++) { double angle = i * Math.PI / 4; g.DrawLine(p, x + (12 + (float)Math.Cos(angle) * 8)*k, y + (12 + (float)Math.Sin(angle) * 8)*k, x + (12 + (float)Math.Cos(angle) * 10.5f)*k, y + (12 + (float)Math.Sin(angle) * 10.5f)*k); } }
            }
        }
    }

    internal sealed class ActionButton : Button
    {
        public string Symbol = "";
        public bool Primary, Selected, Bare;
        private bool hover;
        public ActionButton(string text, string symbol)
        {
            Text = text; Symbol = symbol;
            Font = Theme.Font(10, FontStyle.Bold);
            ForeColor = Theme.Green;
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            AccessibleName = String.IsNullOrEmpty(text) ? symbol : text;
            SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint, true);
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color bg = Primary ? (hover ? Theme.PrimaryHover : Theme.PrimaryBackground) : Selected ? Theme.Selected : hover ? Theme.Pale : Bare ? BackColor : Theme.Background;
            Color ink = Primary ? Theme.PrimaryInk : Theme.Green;
            if (!Enabled) { bg = Theme.Background; ink = Theme.DisabledInk; }
            e.Graphics.Clear(BackColor);
            Theme.Box(e.Graphics, new Rectangle(0, 0, Width - 1, Height - 1), bg, Height / 5f);
            int icon = Math.Min(Height / 2, 26);
            int gap = (int)(Height * .18);
            int textWidth = String.IsNullOrEmpty(Text) ? 0 : TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.NoPadding).Width;
            int total = textWidth + (String.IsNullOrEmpty(Symbol) ? 0 : icon + (textWidth == 0 ? 0 : gap));
            int left = Math.Max(gap, (Width - total) / 2);
            if (Symbol.Length > 0) Theme.Symbol(e.Graphics, Symbol, new Rectangle(left, (Height - icon) / 2, icon, icon), ink);
            int tx = left + (Symbol.Length > 0 ? icon + gap : 0);
            Theme.Text(e.Graphics, Text, Font, ink, new Rectangle(tx, 0, Math.Max(1, Width - tx - gap), Height), TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
            if (Focused && ShowFocusCues)
            {
                using (Pen p = new Pen(ink)) { p.DashStyle = DashStyle.Dot; e.Graphics.DrawRectangle(p, 5, 5, Width - 11, Height - 11); }
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) Font.Dispose(); base.Dispose(disposing); }
    }

    internal sealed class InputBox : Panel
    {
        public readonly TextBox Input = new TextBox();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessage(IntPtr hwnd, int message, IntPtr wParam, string value);
        public InputBox(string placeholder, string name)
        {
            BackColor = Theme.Background;
            DoubleBuffered = true;
            Input.BorderStyle = BorderStyle.None;
            Input.BackColor = BackColor;
            Input.ForeColor = Theme.Ink;
            Input.Font = Theme.Font(11, FontStyle.Regular);
            Input.MaxLength = 120;
            Input.AccessibleName = name;
            Input.HandleCreated += delegate { SendMessage(Input.Handle, 0x1501, new IntPtr(1), placeholder); };
            Input.GotFocus += delegate { Invalidate(); };
            Input.LostFocus += delegate { Invalidate(); };
            Controls.Add(Input);
        }
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Input.SetBounds(14, Math.Max(5, (Height - Input.PreferredHeight) / 2), Math.Max(10, Width - 28), Input.PreferredHeight);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath p = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), 8))
            using (Pen pen = new Pen(Input.Focused ? Theme.Green : Theme.Line, Input.Focused ? 1.5f : 1)) e.Graphics.DrawPath(pen, p);
        }
        protected override void Dispose(bool disposing) { if (disposing) Input.Font.Dispose(); base.Dispose(disposing); }
    }

    internal class Card : Panel
    {
        public Card() { BackColor = Theme.Surface; DoubleBuffered = true; }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath p = Theme.Round(new Rectangle(0, 0, Width - 1, Height - 1), 12))
            using (Pen pen = new Pen(Theme.Line)) e.Graphics.DrawPath(pen, p);
        }
    }

    internal sealed class ThemedScrollBar : Control
    {
        private readonly FlowLayoutPanel list;
        private bool dragging;
        private int dragStart, offsetStart;
        public ThemedScrollBar(FlowLayoutPanel list)
        {
            this.list = list;
            DoubleBuffered = true;
            TabStop = false;
            AccessibleName = "Scroll session history";
            AccessibleRole = AccessibleRole.ScrollBar;
            list.Scroll += delegate { Invalidate(); };
            list.Layout += delegate { Sync(); };
        }
        private int Maximum { get { return Math.Max(0, list.DisplayRectangle.Height - list.ClientSize.Height); } }
        private int Offset { get { return Math.Max(0, -list.AutoScrollPosition.Y); } }
        private Rectangle Thumb
        {
            get
            {
                int height = Math.Min(Height - 8, Math.Max(26, (int)((long)Height * list.ClientSize.Height / Math.Max(1, list.DisplayRectangle.Height))));
                int travel = Math.Max(0, Height - height - 8);
                int y = 4 + (Maximum == 0 ? 0 : (int)((long)travel * Offset / Maximum));
                return new Rectangle(4, y, Math.Max(3, Width - 8), Math.Max(8, height));
            }
        }
        public void Sync()
        {
            bool show = Theme.Dark && list.Visible && list.VerticalScroll.Visible;
            Visible = show;
            BackColor = Theme.Surface;
            if (show)
            {
                SetBounds(list.Parent.Right, list.Parent.Top, SystemInformation.VerticalScrollBarWidth, list.Parent.Height);
                BringToFront();
                Invalidate();
            }
        }
        public void SetOffset(int value)
        {
            list.AutoScrollPosition = new Point(0, Math.Max(0, Math.Min(Maximum, value)));
            Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Surface);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Theme.Box(e.Graphics, Thumb, dragging ? Theme.Green : Theme.Muted, 3);
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (Thumb.Contains(e.Location)) { dragging = true; dragStart = e.Y; offsetStart = Offset; Capture = true; }
            else SetOffset(Offset + (e.Y < Thumb.Top ? -list.ClientSize.Height : list.ClientSize.Height));
            Invalidate();
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging) SetOffset(offsetStart + (int)((long)(e.Y - dragStart) * Maximum / Math.Max(1, Height - Thumb.Height - 8)));
        }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e); dragging = false; Capture = false; Invalidate();
        }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e); SetOffset(Offset - e.Delta / 120 * 60);
        }
    }

    internal sealed class SessionRow : Panel
    {
        private readonly StudySession session;
        private readonly float scale;
        private readonly bool compact;
        private readonly Font titleFont = Theme.Font(10.5f, FontStyle.Bold);
        private readonly Font smallFont = Theme.Font(9, FontStyle.Regular);
        private readonly Font timeFont = Theme.Font(11, FontStyle.Bold);
        private readonly ActionButton delete;
        public SessionRow(StudySession session, float scale, bool compact, Action<StudySession> onDelete)
        {
            this.session = session; this.scale = scale; this.compact = compact;
            BackColor = Theme.Surface;
            DoubleBuffered = true;
            Height = S(compact ? 65 : 78);
            AccessibleName = session.Title + ", " + Format.Friendly(session.DurationMs) + ", " + session.FinishedLocal.ToString("f");
            if (!compact)
            {
                delete = new ActionButton("", "trash") { BackColor = Theme.Surface, Bare = true, AccessibleName = "Delete session: " + session.Title };
                delete.Click += delegate { onDelete(session); };
                Controls.Add(delete);
            }
        }
        private int S(int n) { return (int)Math.Round(n * scale); }
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (delete != null) delete.SetBounds(Width - S(52), S(19), S(38), S(38));
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            bool narrow = Width < S(480);
            if (!narrow)
            {
                Theme.Box(g, new Rectangle(S(19), S(compact ? 14 : 20), S(37), S(37)), Theme.Pale, S(9));
                Theme.Symbol(g, "history", new Rectangle(S(26), S(compact ? 21 : 27), S(23), S(23)), Theme.Green);
            }
            int right = S(compact ? 24 : narrow ? 55 : 74), durationWidth = S(narrow ? 104 : 156), titleX = S(narrow ? 16 : 71);
            int titleWidth = Math.Max(S(70), Width - titleX - S(5) - right - durationWidth);
            Theme.Text(g, session.Title, titleFont, Theme.Ink, new Rectangle(titleX, S(compact ? 11 : 17), titleWidth, S(25)), TextFormatFlags.VerticalCenter);
            Theme.Text(g, session.FinishedLocal.ToString("ddd, MMM d  ·  h:mm tt"), smallFont, Theme.Muted, new Rectangle(titleX, S(compact ? 36 : 43), titleWidth, S(20)), TextFormatFlags.VerticalCenter);
            Theme.Text(g, Format.Friendly(session.DurationMs), timeFont, Theme.Ink, new Rectangle(Width - right - durationWidth, S(compact ? 14 : 24), durationWidth, S(32)), TextFormatFlags.Right | TextFormatFlags.VerticalCenter);
            using (Pen pen = new Pen(Theme.Line)) g.DrawLine(pen, S(20), Height - 1, Width - S(20), Height - 1);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { titleFont.Dispose(); smallFont.Dispose(); timeFont.Dispose(); }
            base.Dispose(disposing);
        }
    }

    internal sealed class StudyForm : Form
    {
        private readonly SessionEngine engine;
        private readonly float scale;
        private readonly Timer ticker = new Timer();
        private readonly Font brandFont = Theme.Font(21, FontStyle.Bold);
        private readonly Font headingFont = Theme.Font(27, FontStyle.Bold);
        private readonly Font titleFont = Theme.Font(13, FontStyle.Bold);
        private readonly Font bodyFont = Theme.Font(10, FontStyle.Regular);
        private readonly Font smallFont = Theme.Font(8.5f, FontStyle.Regular);
        private readonly Font microFont = Theme.Font(8, FontStyle.Bold);
        private readonly Font numberFont = Theme.Font(66, FontStyle.Regular);
        private readonly Font floatingNumberFont = Theme.Font(42, FontStyle.Regular);
        private readonly Font statFont = Theme.Font(22, FontStyle.Bold);
        private readonly Card timerCard = new Card();
        private readonly Card recentCard = new Card();
        private readonly Card historyCard = new Card();
        private readonly Card[] stats = { new Card(), new Card(), new Card() };
        private readonly InputBox titleInput = new InputBox("What are you studying?", "Study session title");
        private readonly InputBox searchInput = new InputBox("Search session titles…", "Search session history");
        internal readonly ActionButton StartButton = new ActionButton("Start studying", "play") { Primary = true };
        internal readonly ActionButton ResetButton = new ActionButton("", "reset") { AccessibleName = "Reset current session" };
        internal readonly ActionButton FinishButton = new ActionButton("Finish session", "check");
        internal readonly ActionButton AlwaysOnTopButton = new ActionButton("Always on top", "pin");
        internal readonly ActionButton DarkModeButton = new ActionButton("Dark mode", "moon") { Bare = true };
        private readonly ActionButton timerNav = new ActionButton("Study timer", "clock");
        private readonly ActionButton historyNav = new ActionButton("Session history", "history");
        private readonly ActionButton viewAll = new ActionButton("View all", "arrow") { Bare = true };
        private readonly ActionButton exportButton = new ActionButton("Export CSV", "export");
        private readonly FlowLayoutPanel sessionList = new FlowLayoutPanel();
        private readonly Panel historyViewport = new Panel();
        private readonly ThemedScrollBar historyScroll;
        private readonly List<SessionRow> recentRows = new List<SessionRow>();
        private readonly ToolTip tips = new ToolTip();
        private bool historyView, synchronizing, titleDirty, listDirty, compactLayout, showRecent, floatingWindow;
        private DateTime lastSave = DateTime.UtcNow, lastTitleChange, lastSearchChange;
        private string notice = "", lastRenderedTime = "", lastFilter = "";
        private DateTime noticeUntil;
        private int filteredCount;
        internal bool SkipConfirmations;
        public StudyForm(SessionEngine engine, bool preview)
        {
            this.engine = engine;
            historyScroll = new ThemedScrollBar(sessionList);
            using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
            Text = "Studytime — study timer";
            AutoScaleMode = AutoScaleMode.None;
            Font = bodyFont; ForeColor = Theme.Ink; BackColor = Theme.Background;
            Rectangle screen = Screen.PrimaryScreen.WorkingArea;
            Size chrome = SizeFromClientSize(Size.Empty);
            int availableWidth = screen.Width - S(24), availableHeight = screen.Height - S(24);
            MinimumSize = new Size(Math.Min(S(380), availableWidth), Math.Min(S(350), availableHeight));
            ClientSize = new Size(Math.Min(S(1180), availableWidth - chrome.Width), Math.Min(S(910), availableHeight - chrome.Height));
            StartPosition = FormStartPosition.CenterScreen;
            DoubleBuffered = true;
            KeyPreview = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            timerNav.BackColor = historyNav.BackColor = Theme.Sidebar;
            timerNav.Bare = historyNav.Bare = true;
            Controls.AddRange(new Control[] { timerNav, historyNav, timerCard, recentCard, historyCard, viewAll, AlwaysOnTopButton, DarkModeButton });
            Controls.AddRange(stats);
            timerCard.Controls.AddRange(new Control[] { titleInput, StartButton, ResetButton, FinishButton });
            historyViewport.Controls.Add(sessionList);
            historyCard.Controls.AddRange(new Control[] { searchInput, exportButton, historyViewport, historyScroll });
            titleInput.Input.Text = engine.Title;
            titleInput.Input.TabIndex = 0; StartButton.TabIndex = 1; ResetButton.TabIndex = 2; FinishButton.TabIndex = 3;
            tips.SetToolTip(StartButton, "Start or pause studying (Space, outside a text field)");
            tips.SetToolTip(ResetButton, "Reset the current timer and keep its title (Ctrl+R)");
            tips.SetToolTip(FinishButton, "Save this session to history (Ctrl+Enter)");
            tips.SetToolTip(timerNav, "Study timer (Ctrl+T)");
            tips.SetToolTip(historyNav, "Session history (Ctrl+H)");
            AlwaysOnTopButton.Click += delegate { ToggleAlwaysOnTop(); };
            DarkModeButton.Click += delegate { ToggleDarkMode(); };
            ApplyAlwaysOnTop();
            sessionList.BackColor = Theme.Surface;
            sessionList.AutoScroll = true;
            sessionList.WrapContents = false;
            sessionList.FlowDirection = FlowDirection.TopDown;
            sessionList.Resize += delegate { SizeHistoryRows(); };
            titleInput.Input.TextChanged += delegate
            {
                if (synchronizing) return;
                engine.SetTitle(titleInput.Input.Text);
                titleDirty = true;
                lastTitleChange = DateTime.UtcNow;
            };
            searchInput.Input.TextChanged += delegate { listDirty = true; lastSearchChange = DateTime.UtcNow; };
            StartButton.Click += delegate { Act(delegate { if (engine.Running) engine.Pause(); else engine.Start(); }); };
            ResetButton.Click += delegate { ResetSession(); };
            FinishButton.Click += delegate { FinishSession(); };
            timerNav.Click += delegate { ShowHistory(false); };
            historyNav.Click += delegate { ShowHistory(true); };
            viewAll.Click += delegate { ShowHistory(true); };
            exportButton.Click += delegate { Export(); };
            timerCard.Paint += PaintTimer;
            recentCard.Paint += PaintRecent;
            historyCard.Paint += PaintHistory;
            for (int i = 0; i < 3; i++) { int index = i; stats[i].Paint += delegate(object sender, PaintEventArgs e) { PaintStat(e, index); }; }
            Resize += delegate { LayoutUI(); };
            FormClosing += OnFormClosingSave;
            ticker.Interval = 100;
            ticker.Tick += Tick;
            Shown += delegate { titleInput.Input.Focus(); };
            HandleCreated += delegate { ApplyFrameTheme(); };
            ApplyAppearance();
            ShowHistory(false);
            RefreshData();
            UpdateTimer();
            LayoutUI();
            if (engine.Restored) Notify("Previous session restored and paused. Resume when you’re ready.", 15);
            if (!preview) ticker.Start();
        }
        private int S(int n) { return (int)Math.Round(n * scale); }
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        private void ApplyFrameTheme()
        {
            if (!IsHandleCreated) return;
            try
            {
                // DWMWA_USE_IMMERSIVE_DARK_MODE: documented Windows frame opt-in.
                // https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
                int dark = engine.DarkMode ? 1 : 0;
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
                // Windows 11 caption/text colors; older systems ignore unsupported attributes.
                int caption = engine.DarkMode ? Theme.Sidebar.R | (Theme.Sidebar.G << 8) | (Theme.Sidebar.B << 16) : -1;
                int text = engine.DarkMode ? Theme.Ink.R | (Theme.Ink.G << 8) | (Theme.Ink.B << 16) : -1;
                DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
                DwmSetWindowAttribute(Handle, 36, ref text, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }
        private void ColorControls(Control control)
        {
            control.ForeColor = Theme.Ink;
            if (control is Form || control is InputBox || control is TextBox) control.BackColor = Theme.Background;
            else if (control is Card || control is SessionRow || control is FlowLayoutPanel || control is ThemedScrollBar || control == historyViewport) control.BackColor = Theme.Surface;
            else if (control is ActionButton) control.BackColor = control.Parent.BackColor;
            foreach (Control child in control.Controls) ColorControls(child);
            control.Invalidate();
        }
        private void ApplyAppearance()
        {
            Theme.SetDark(engine.DarkMode);
            SuspendLayout();
            ColorControls(this);
            DarkModeButton.Selected = engine.DarkMode;
            DarkModeButton.Symbol = engine.DarkMode ? "sun" : "moon";
            DarkModeButton.AccessibleName = "Switch to " + (engine.DarkMode ? "light mode" : "dark mode");
            tips.SetToolTip(DarkModeButton, DarkModeButton.AccessibleName + " (Ctrl+Shift+D)");
            if (toast != null) toast.BackColor = Theme.PrimaryBackground;
            LayoutUI();
            ApplyFrameTheme();
            ResumeLayout();
            Invalidate(true);
        }
        private void ToggleDarkMode()
        {
            try { engine.SetDarkMode(!engine.DarkMode); ApplyAppearance(); titleDirty = false; lastSave = DateTime.UtcNow; }
            catch (Exception e) { ShowSaveError(e); }
        }
        private void ApplyAlwaysOnTop()
        {
            TopMost = engine.AlwaysOnTop;
            AlwaysOnTopButton.Primary = TopMost;
            AlwaysOnTopButton.AccessibleName = "Always on top: " + (TopMost ? "on" : "off");
            tips.SetToolTip(AlwaysOnTopButton, "Always on top is " + (TopMost ? "on. Click to turn off." : "off. Click to keep Studytime above other windows.") + " (Ctrl+Shift+T)");
            AlwaysOnTopButton.Invalidate();
        }
        private void ToggleAlwaysOnTop()
        {
            try { engine.SetAlwaysOnTop(!TopMost); ApplyAlwaysOnTop(); titleDirty = false; lastSave = DateTime.UtcNow; }
            catch (Exception e) { ShowSaveError(e); }
        }
        private bool Act(Action action)
        {
            try
            {
                action(); titleDirty = false; lastSave = DateTime.UtcNow;
                UpdateTimer(); RefreshData();
                return true;
            }
            catch (Exception e) { ShowSaveError(e); return false; }
        }
        private void ShowSaveError(Exception e)
        {
            MessageBox.Show(this, "The session could not be saved. Please check that your disk has space and try again.\n\n" + e.Message, "Studytime — save error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        private void ResetSession()
        {
            bool resume = engine.Running;
            if (engine.ElapsedMs > 0 && !SkipConfirmations)
            {
                // The confirmation dialog is break time too.
                if (resume) { try { engine.Pause(); UpdateTimer(); } catch (Exception e) { ShowSaveError(e); return; } }
                if (MessageBox.Show(this, "Reset this session’s timer?\n\nThe current time will be discarded. Your title and finished sessions will be kept.", "Reset session", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
                {
                    if (resume) Act(engine.Start);
                    return;
                }
            }
            if (Act(engine.Reset)) Notify("Timer reset. Your session title is ready for a fresh start.", 5);
        }
        private void FinishSession()
        {
            if (engine.ElapsedMs <= 0) return;
            try
            {
                StudySession session = engine.Finish();
                synchronizing = true; titleInput.Input.Text = ""; synchronizing = false;
                titleDirty = false; lastSave = DateTime.UtcNow;
                UpdateTimer(); RefreshData();
                Notify("Session saved · " + Format.Friendly(session.DurationMs) + " of focused study.", 8);
            }
            catch (Exception e) { ShowSaveError(e); }
        }
        internal void ShowHistory(bool show)
        {
            historyView = show;
            timerNav.Selected = !show; historyNav.Selected = show;
            timerNav.Invalidate(); historyNav.Invalidate();
            timerCard.Visible = recentCard.Visible = viewAll.Visible = !show;
            foreach (Card card in stats) card.Visible = !show;
            historyCard.Visible = show;
            LayoutUI(); Invalidate();
            if (show) searchInput.Input.Focus();
        }
        private void Tick(object sender, EventArgs e)
        {
            UpdateTimer();
            DateTime now = DateTime.UtcNow;
            if (listDirty && (now - lastSearchChange).TotalMilliseconds >= 220) { RenderHistory(); listDirty = false; }
            if ((titleDirty && (now - lastTitleChange).TotalMilliseconds >= 700) || (engine.Running && (now - lastSave).TotalSeconds >= 5))
            {
                try { engine.Checkpoint(); titleDirty = false; lastSave = now; }
                catch { lastSave = now.AddSeconds(25); titleDirty = true; lastTitleChange = now.AddSeconds(30); Notify("Autosave failed. Keep the app open and try saving again.", 30); }
            }
            if (notice.Length > 0 && now > noticeUntil) { notice = ""; Invalidate(); }
        }
        private void UpdateTimer()
        {
            string value = Format.Clock(engine.ElapsedMs);
            Text = engine.Started ? value + " · " + (engine.Running ? "Studying" : "Paused") + " — Studytime" : "Studytime — study timer";
            if (value != lastRenderedTime) { lastRenderedTime = value; timerCard.Invalidate(); }
            StartButton.Text = engine.Running ? (floatingWindow ? "Pause" : "Pause studying") : engine.Started ? (floatingWindow ? "Resume" : "Resume studying") : (floatingWindow ? "Start" : "Start studying");
            FinishButton.Text = floatingWindow ? "Finish" : "Finish session";
            StartButton.AccessibleName = StartButton.Text;
            StartButton.Symbol = engine.Running ? "pause" : "play";
            StartButton.Invalidate();
            ResetButton.Enabled = engine.Started;
            FinishButton.Enabled = engine.ElapsedMs > 0;
            timerCard.Invalidate();
        }
        private void RefreshData()
        {
            recentCard.SuspendLayout();
            foreach (SessionRow row in recentRows) { recentCard.Controls.Remove(row); row.Dispose(); }
            recentRows.Clear();
            foreach (StudySession session in engine.Sessions.OrderByDescending(s => s.FinishedUtc).Take(3))
            {
                SessionRow row = new SessionRow(session, scale, true, null);
                recentRows.Add(row); recentCard.Controls.Add(row);
            }
            recentCard.ResumeLayout();
            exportButton.Enabled = engine.Sessions.Count > 0;
            RenderHistory();
            foreach (Card card in stats) card.Invalidate();
            recentCard.Invalidate();
            LayoutUI();
        }
        private void RenderHistory()
        {
            string query = searchInput.Input.Text.Trim();
            lastFilter = query;
            List<StudySession> sessions = engine.Sessions.Where(s => s.Title.IndexOf(query, StringComparison.CurrentCultureIgnoreCase) >= 0).OrderByDescending(s => s.FinishedUtc).ToList();
            filteredCount = sessions.Count;
            sessionList.Visible = filteredCount > 0;
            historyViewport.Visible = filteredCount > 0;
            sessionList.SuspendLayout();
            foreach (Control control in sessionList.Controls.Cast<Control>().ToArray()) { sessionList.Controls.Remove(control); control.Dispose(); }
            foreach (StudySession session in sessions)
            {
                SessionRow row = new SessionRow(session, scale, false, DeleteSession) { Margin = Padding.Empty };
                sessionList.Controls.Add(row);
            }
            SizeHistoryRows();
            sessionList.ResumeLayout();
            historyCard.Invalidate();
        }
        private void SizeHistoryRows()
        {
            // Always reserve scrollbar space, avoiding horizontal scrollbars when it appears.
            foreach (Control control in sessionList.Controls) control.Width = Math.Max(S(200), historyViewport.ClientSize.Width - (Theme.Dark ? 0 : SystemInformation.VerticalScrollBarWidth) - 2);
            historyScroll.Sync();
        }
        private void LayoutHistoryList(int x, int y, int width, int height)
        {
            // Clip the native scrollbar outside the viewport in dark mode, then
            // render the themed scrollbar beside it. Native wheel scrolling stays intact.
            historyViewport.SetBounds(x, y, width - (Theme.Dark ? SystemInformation.VerticalScrollBarWidth : 0), height);
            sessionList.SetBounds(0, 0, width, height);
        }
        private void DeleteSession(StudySession session)
        {
            if (MessageBox.Show(this, "Delete “" + session.Title + "” from your history?\n\nThis cannot be undone.", "Delete session", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
            {
                if (Act(delegate { engine.Delete(session.Id); })) Notify("Session deleted.", 4);
            }
        }
        private void Export()
        {
            using (SaveFileDialog dialog = new SaveFileDialog { Title = "Export your study sessions", Filter = "CSV file (*.csv)|*.csv", FileName = "Studytime-sessions-" + DateTime.Now.ToString("yyyy-MM-dd") + ".csv", AddExtension = true, DefaultExt = "csv" })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try { File.WriteAllText(dialog.FileName, Format.Csv(engine.Sessions), new UTF8Encoding(true)); Notify("All finished sessions exported to CSV.", 7); }
                catch (Exception e) { MessageBox.Show(this, "The export could not be written.\n\n" + e.Message, "Export error", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }
        }
        private void Notify(string message, int seconds)
        {
            notice = message; noticeUntil = DateTime.UtcNow.AddSeconds(seconds); Invalidate();
        }
        private void OnFormClosingSave(object sender, FormClosingEventArgs e)
        {
            try { engine.Close(); ticker.Stop(); }
            catch (Exception error)
            {
                e.Cancel = true;
                ShowSaveError(error);
                if (MessageBox.Show(this, "Close without saving the latest changes?\n\nYour most recent autosaved session can still be restored.", "Close Studytime", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.Yes)
                { ticker.Stop(); e.Cancel = false; }
            }
        }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == (Keys.Control | Keys.Shift | Keys.D)) { ToggleDarkMode(); return true; }
            if (keyData == (Keys.Control | Keys.Shift | Keys.T)) { ToggleAlwaysOnTop(); return true; }
            if (keyData == (Keys.Control | Keys.H)) { ShowHistory(true); return true; }
            if (keyData == (Keys.Control | Keys.T)) { ShowHistory(false); return true; }
            if (keyData == (Keys.Control | Keys.Enter)) { FinishSession(); return true; }
            if (keyData == (Keys.Control | Keys.R)) { ResetSession(); return true; }
            if (keyData == Keys.Space && !titleInput.Input.Focused && !searchInput.Input.Focused)
            { Act(delegate { if (engine.Running) engine.Pause(); else engine.Start(); }); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }
        private void LayoutUI()
        {
            if (scale <= 0) return;
            floatingWindow = ClientSize.Width < S(930) || ClientSize.Height < S(590);
            timerCard.Visible = !historyView;
            historyCard.Visible = historyView;
            foreach (Card stat in stats) stat.Visible = !historyView && !floatingWindow;
            if (floatingWindow)
            {
                compactLayout = true; showRecent = false;
                recentCard.Visible = viewAll.Visible = false;
                timerNav.Text = historyNav.Text = "";
                timerNav.AccessibleName = "Study timer"; historyNav.AccessibleName = "Session history";
                timerNav.BackColor = historyNav.BackColor = Theme.Background;
                timerNav.SetBounds(S(12), S(12), S(37), S(36));
                historyNav.SetBounds(S(55), S(12), S(37), S(36));
                DarkModeButton.Text = "";
                DarkModeButton.BackColor = Theme.Background;
                DarkModeButton.SetBounds(S(98), S(12), S(37), S(36));
                AlwaysOnTopButton.SetBounds(ClientSize.Width - S(192), S(12), S(180), S(36));
                int cardWidth = ClientSize.Width - S(24), floatingCardHeight = ClientSize.Height - S(80);
                timerCard.SetBounds(S(12), S(68), cardWidth, floatingCardHeight);
                titleInput.SetBounds(S(16), S(36), cardWidth - S(32), S(36));
                int buttonTopSmall = floatingCardHeight - S(54), startWidth = cardWidth - S(190);
                StartButton.SetBounds(S(16), buttonTopSmall, startWidth, S(42));
                ResetButton.SetBounds(S(24) + startWidth, buttonTopSmall, S(42), S(42));
                FinishButton.SetBounds(S(74) + startWidth, buttonTopSmall, S(100), S(42));
                historyCard.SetBounds(S(12), S(68), cardWidth, floatingCardHeight);
                searchInput.SetBounds(S(16), S(35), cardWidth - S(106), S(36));
                exportButton.Text = "CSV";
                exportButton.SetBounds(cardWidth - S(82), S(35), S(66), S(36));
                LayoutHistoryList(S(3), S(110), cardWidth - S(6), Math.Max(S(40), floatingCardHeight - S(117)));
                SizeHistoryRows(); UpdateTimer(); Invalidate();
                return;
            }
            timerNav.Text = "Study timer"; historyNav.Text = "Session history";
            timerNav.BackColor = historyNav.BackColor = Theme.Sidebar;
            DarkModeButton.Text = engine.DarkMode ? "Light mode" : "Dark mode";
            DarkModeButton.BackColor = Theme.Sidebar;
            DarkModeButton.SetBounds(S(18), S(257), S(190), S(46));
            exportButton.Text = "Export CSV";
            AlwaysOnTopButton.SetBounds(ClientSize.Width - S(214), S(42), S(180), S(36));
            int left = S(246), width = Math.Max(S(570), ClientSize.Width - left - S(34));
            compactLayout = ClientSize.Height < S(850);
            int cardTop = compactLayout ? 116 : 141;
            int cardHeight = compactLayout ? 330 : 360;
            int statsTop = cardTop + cardHeight + 16;
            int recentHeader = statsTop + 129;
            int recentTop = recentHeader + 41;
            showRecent = ClientSize.Height >= S(recentTop + 93);
            recentCard.Visible = viewAll.Visible = !historyView && showRecent;
            timerNav.SetBounds(S(18), S(145), S(190), S(46));
            historyNav.SetBounds(S(18), S(200), S(190), S(46));
            timerCard.SetBounds(left, S(cardTop), width, S(cardHeight));
            titleInput.SetBounds(S(29), S(55), width - S(58), S(45));
            int controlsWidth = S(443), controlsX = (width - controlsWidth) / 2;
            int buttonTop = compactLayout ? 246 : 271;
            StartButton.SetBounds(controlsX, S(buttonTop), S(206), S(47));
            ResetButton.SetBounds(controlsX + S(217), S(buttonTop), S(48), S(47));
            FinishButton.SetBounds(controlsX + S(276), S(buttonTop), S(167), S(47));
            int statWidth = (width - S(28)) / 3;
            for (int i = 0; i < 3; i++) stats[i].SetBounds(left + i * (statWidth + S(14)), S(statsTop), i == 2 ? width - 2 * (statWidth + S(14)) : statWidth, S(99));
            viewAll.BackColor = Theme.Background;
            viewAll.SetBounds(left + width - S(112), S(recentHeader - 4), S(112), S(34));
            recentCard.SetBounds(left, S(recentTop), width, Math.Max(S(65), ClientSize.Height - S(recentTop + 27)));
            for (int i = 0; i < recentRows.Count; i++)
            {
                recentRows[i].SetBounds(S(1), S(1) + i * S(65), width - S(2), S(65));
                recentRows[i].Visible = (i + 1) * S(65) + S(2) <= recentCard.Height;
            }
            historyCard.SetBounds(left, S(cardTop), width, Math.Max(S(300), ClientSize.Height - S(cardTop + 28)));
            searchInput.SetBounds(S(25), S(35), Math.Max(S(240), width - S(225)), S(44));
            exportButton.SetBounds(width - S(174), S(35), S(148), S(44));
            LayoutHistoryList(S(5), S(117), width - S(10), historyCard.Height - S(124));
            SizeHistoryRows();
            UpdateTimer();
            Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            if (floatingWindow)
            {
                // The same controls stay available in a small floating window.
                if (notice.Length > 0) ShowToast(S(12), S(54), ClientSize.Width - S(24), S(38));
                else if (toast != null) toast.Visible = false;
                return;
            }
            using (SolidBrush bg = new SolidBrush(Theme.Sidebar)) g.FillRectangle(bg, 0, 0, S(222), ClientSize.Height);
            Theme.Box(g, new Rectangle(S(25), S(31), S(37), S(37)), Theme.PrimaryBackground, S(10));
            Theme.Symbol(g, "clock", new Rectangle(S(31), S(37), S(25), S(25)), Theme.PrimaryInk);
            Theme.Text(g, "studytime", brandFont, Theme.Ink, new Rectangle(S(25), S(78), S(185), S(36)), TextFormatFlags.Left);
            Theme.Text(g, "YOUR FOCUS, MEASURED", microFont, Theme.Muted, new Rectangle(S(26), S(118), S(185), S(18)), TextFormatFlags.Left);
            Theme.Text(g, "A little focus.\nA lot of progress.", titleFont, Theme.Green, new Rectangle(S(25), ClientSize.Height - S(170), S(172), S(63)), TextFormatFlags.WordBreak);
            using (Pen line = new Pen(Theme.Line)) g.DrawLine(line, S(25), ClientSize.Height - S(87), S(195), ClientSize.Height - S(87));
            Theme.Text(g, "Saved on this computer.\nReady when you are.", smallFont, Theme.Muted, new Rectangle(S(25), ClientSize.Height - S(67), S(178), S(48)), TextFormatFlags.WordBreak);
            int left = S(246), width = ClientSize.Width - left - S(34);
            Theme.Text(g, historyView ? "Your study sessions" : "Time to focus.", headingFont, Theme.Ink, new Rectangle(left, S(compactLayout ? 20 : 36), width - S(195), S(48)), TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            Theme.Text(g, historyView ? "Every finished session, all in one place." : "Build your next good study session, one minute at a time.", bodyFont, Theme.Muted, new Rectangle(left + S(1), S(compactLayout ? 70 : 89), width, S(24)), TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            if (!historyView && showRecent)
            {
                Theme.Text(g, "Recent sessions", titleFont, Theme.Ink, new Rectangle(left, S(compactLayout ? 591 : 646), width - S(125), S(31)), TextFormatFlags.VerticalCenter);
            }
            if (notice.Length > 0)
            {
                int w = Math.Min(S(630), width - S(30)), h = S(43), x = left + (width - w) / 2, y = ClientSize.Height - S(70);
                // Bring the toast to the front using a separate overlay control below.
                ShowToast(x, y, w, h);
            }
            else if (toast != null) toast.Visible = false;
        }
        private Panel toast;
        private void ShowToast(int x, int y, int w, int h)
        {
            if (toast == null)
            {
                toast = new Panel { BackColor = Theme.PrimaryBackground, Enabled = false };
                toast.Paint += delegate(object sender, PaintEventArgs e) { Theme.Text(e.Graphics, notice, bodyFont, Theme.PrimaryInk, new Rectangle(S(16), 0, toast.Width - S(32), toast.Height), TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter); };
                Controls.Add(toast);
            }
            toast.SetBounds(x, y, w, h); toast.Visible = true; toast.BringToFront(); toast.Invalidate();
        }
        private void PaintTimer(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            int width = timerCard.Width;
            if (floatingWindow)
            {
                string smallState = engine.Running ? "FOCUSING" : engine.Started ? "PAUSED" : "READY";
                Theme.Text(g, "SESSION TITLE", microFont, Theme.Muted, new Rectangle(S(16), S(10), S(145), S(18)), TextFormatFlags.VerticalCenter);
                Theme.Text(g, smallState, microFont, engine.Running ? Theme.Green : Theme.Muted, new Rectangle(width - S(116), S(10), S(100), S(18)), TextFormatFlags.Right | TextFormatFlags.VerticalCenter);
                int clockTop = Math.Max(S(76), (timerCard.Height - S(68)) / 2);
                Theme.Text(g, Format.Clock(engine.ElapsedMs), floatingNumberFont, Theme.Ink, new Rectangle(S(8), clockTop, width - S(16), S(69)), TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
                Theme.Text(g, "HOURS    MINUTES    SECONDS", microFont, Theme.Muted, new Rectangle(S(8), clockTop + S(69), width - S(16), S(17)), TextFormatFlags.HorizontalCenter);
                return;
            }
            Theme.Text(g, "SESSION TITLE", microFont, Theme.Muted, new Rectangle(S(29), S(22), S(200), S(18)), TextFormatFlags.VerticalCenter);
            string state = engine.Running ? "FOCUSING" : engine.Started ? "PAUSED" : "READY";
            Color bg = engine.Running ? Theme.Pale : Theme.Background;
            Theme.Box(g, new Rectangle(width - S(132), S(17), S(103), S(27)), bg, S(12));
            using (SolidBrush brush = new SolidBrush(engine.Running ? Theme.Green : Theme.Muted)) g.FillEllipse(brush, width - S(119), S(28), S(5), S(5));
            Theme.Text(g, state, microFont, engine.Running ? Theme.Green : Theme.Muted, new Rectangle(width - S(104), S(17), S(66), S(27)), TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
            string clock = Format.Clock(engine.ElapsedMs);
            Theme.Text(g, clock, numberFont, Theme.Ink, new Rectangle(S(10), S(compactLayout ? 101 : 118), width - S(20), S(119)), TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter);
            Theme.Text(g, "H O U R S       M I N U T E S       S E C O N D S", microFont, Theme.Muted, new Rectangle(S(20), S(compactLayout ? 214 : 233), width - S(40), S(19)), TextFormatFlags.HorizontalCenter);
            Theme.Text(g, engine.Running ? "Only time spent studying counts. Pause whenever you take a break." : engine.Started ? "Take your time. Your study time is safely paused." : "Space to start or pause  ·  Ctrl+Enter to finish", smallFont, Theme.Muted, new Rectangle(S(20), S(compactLayout ? 307 : 333), width - S(40), S(17)), TextFormatFlags.HorizontalCenter);
        }
        private void PaintStat(PaintEventArgs e, int index)
        {
            DateTime today = DateTime.Today;
            DateTime weekStart = today.AddDays(-((int)today.DayOfWeek + 6) % 7);
            IEnumerable<StudySession> sessions = engine.Sessions;
            if (index == 0) sessions = sessions.Where(s => s.FinishedLocal.Date == today);
            if (index == 1) sessions = sessions.Where(s => s.FinishedLocal.Date >= weekStart && s.FinishedLocal.Date <= today);
            long elapsed = sessions.Sum(s => s.DurationMs);
            long minutes = elapsed / 60000;
            string amount = elapsed < 60000 && elapsed > 0 ? "< 1 min" : minutes < 60 ? minutes + " min" : minutes / 60 + "h " + minutes % 60 + "m";
            Graphics g = e.Graphics;
            Theme.Text(g, new[] { "TODAY", "THIS WEEK", "ALL TIME" }[index], microFont, Theme.Muted, new Rectangle(S(20), S(15), stats[index].Width - S(40), S(18)), TextFormatFlags.Left);
            Theme.Text(g, amount, statFont, Theme.Ink, new Rectangle(S(20), S(37), stats[index].Width - S(40), S(37)), TextFormatFlags.VerticalCenter);
            int count = sessions.Count();
            Theme.Text(g, count + (count == 1 ? " finished session" : " finished sessions"), smallFont, Theme.Muted, new Rectangle(S(21), S(77), stats[index].Width - S(40), S(16)), TextFormatFlags.Left);
        }
        private void PaintRecent(object sender, PaintEventArgs e)
        {
            if (recentRows.Count > 0) return;
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            int y = (recentCard.Height - S(72)) / 2;
            Theme.Box(g, new Rectangle(S(30), y + S(13), S(48), S(48)), Theme.Pale, S(12));
            Theme.Symbol(g, "history", new Rectangle(S(42), y + S(25), S(24), S(24)), Theme.Green);
            Theme.Text(g, "Your first session starts here.", titleFont, Theme.Ink, new Rectangle(S(97), y + S(12), recentCard.Width - S(120), S(27)), TextFormatFlags.Left);
            Theme.Text(g, "Finish a study session and it will appear in your history.", bodyFont, Theme.Muted, new Rectangle(S(97), y + S(45), recentCard.Width - S(120), S(27)), TextFormatFlags.Left);
        }
        private void PaintHistory(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            string caption = lastFilter.Length > 0 ? filteredCount + " matching " + (filteredCount == 1 ? "session" : "sessions") : engine.Sessions.Count + " finished " + (engine.Sessions.Count == 1 ? "session" : "sessions");
            Theme.Text(g, "SEARCH BY TITLE", microFont, Theme.Muted, new Rectangle(S(27), S(12), historyCard.Width - S(54), S(18)), TextFormatFlags.Left);
            Theme.Text(g, caption, smallFont, Theme.Muted, new Rectangle(S(27), S(87), historyCard.Width - S(54), S(20)), TextFormatFlags.VerticalCenter);
            if (filteredCount > 0) return;
            if (floatingWindow)
            {
                Theme.Text(g, lastFilter.Length > 0 ? "No matching sessions" : "No finished sessions yet", titleFont, Theme.Ink, new Rectangle(S(10), S(130), historyCard.Width - S(20), S(28)), TextFormatFlags.HorizontalCenter);
                Theme.Text(g, lastFilter.Length > 0 ? "Try a different title." : "Finish a session to save it here.", smallFont, Theme.Muted, new Rectangle(S(10), S(169), historyCard.Width - S(20), S(22)), TextFormatFlags.HorizontalCenter);
                return;
            }
            int y = Math.Max(S(145), historyCard.Height / 2 - S(65));
            Theme.Symbol(g, "history", new Rectangle((historyCard.Width - S(48)) / 2, y, S(48), S(48)), Theme.Green);
            Theme.Text(g, lastFilter.Length > 0 ? "No matching sessions" : "A fresh page for your progress.", titleFont, Theme.Ink, new Rectangle(S(20), y + S(70), historyCard.Width - S(40), S(27)), TextFormatFlags.HorizontalCenter);
            Theme.Text(g, lastFilter.Length > 0 ? "Try a different title or clear the search." : "Finished sessions will be saved here automatically.", bodyFont, Theme.Muted, new Rectangle(S(20), y + S(105), historyCard.Width - S(40), S(27)), TextFormatFlags.HorizontalCenter);
        }
        internal void SearchForTest(string text) { searchInput.Input.Text = text; RenderHistory(); }
        internal int FilteredCount { get { return filteredCount; } }
        internal void SetTitleForTest(string text) { titleInput.Input.Text = text; }
        internal bool FloatingForTest { get { return floatingWindow; } }
        internal bool TimerControlsFitForTest
        {
            get { return timerCard.ClientRectangle.Contains(titleInput.Bounds) && timerCard.ClientRectangle.Contains(StartButton.Bounds) && timerCard.ClientRectangle.Contains(ResetButton.Bounds) && timerCard.ClientRectangle.Contains(FinishButton.Bounds) && ClientRectangle.Contains(AlwaysOnTopButton.Bounds) && ClientRectangle.Contains(DarkModeButton.Bounds); }
        }
        internal bool ThemeColorsMatchForTest
        {
            get { return BackColor == Theme.Background && timerCard.BackColor == Theme.Surface && historyCard.BackColor == Theme.Surface && titleInput.Input.BackColor == Theme.Background && titleInput.Input.ForeColor == Theme.Ink && searchInput.Input.BackColor == Theme.Background && searchInput.Input.ForeColor == Theme.Ink && sessionList.BackColor == Theme.Surface && sessionList.Controls.Cast<Control>().All(row => row.BackColor == Theme.Surface); }
        }
        internal void ShortcutForTest(Keys keys) { Message message = new Message(); ProcessCmdKey(ref message, keys); }
        internal int ScrollHistoryForTest(int offset) { historyScroll.SetOffset(offset); return -sessionList.AutoScrollPosition.Y; }
        internal bool DarkScrollVisibleForTest { get { return historyScroll.Visible; } }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                ticker.Dispose(); tips.Dispose();
                foreach (Font font in new[] { brandFont, headingFont, titleFont, smallFont, microFont, numberFont, floatingNumberFont, statFont }) font.Dispose();
                if (Icon != null) Icon.Dispose();
            }
            base.Dispose(disposing);
            if (disposing) bodyFont.Dispose();
        }
    }
}
