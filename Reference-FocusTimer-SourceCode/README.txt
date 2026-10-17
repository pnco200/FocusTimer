STUDYTIME 1.2 — WINDOWS STUDY TIMER

GET STARTED
Double-click Studytime.exe. No installer, internet connection, account,
Python, Node.js, or developer tools are needed to use it.
The application uses the Windows .NET Framework 4.8 runtime.
It was built and tested on this computer, which already has that runtime.
You can move the executable to any convenient folder or make a shortcut.

KEEP THE TIMER ABOVE OTHER PROGRAMS
Click Always on top in the top-right corner. The button turns green when
enabled, and Studytime stays above ordinary windows while you use other
programs. Click it again to turn the feature off, or press Ctrl+Shift+T.
The setting is remembered when you close and reopen the application.
Drag the window edges or corners to resize it. A smaller window switches
automatically to a compact timer with Start/Pause/Resume, Reset and Finish.
Use the clock and history icons at the top to switch between views.
Drag the title bar to move the floating timer anywhere on your screen.
To update an older copy, close it and replace its executable with this
version. Your existing sessions are read from the same saved data folder.

DARK MODE
Click Dark mode in the sidebar to switch to the dark theme. Click Light
mode to switch back. In a compact window, use the moon/sun icon at the top.
Ctrl+Shift+D toggles the theme from either view, including text fields.
The selected theme is saved and restored when you reopen the application.
The timer, history, search fields, buttons and totals follow your choice.

YOUR STUDY SESSION
1. Enter an optional title in the Session Title field.
2. Click Start studying to begin the stopwatch.
3. Click Pause studying whenever you take a break.
4. Click Resume studying when you return. Paused time is never added.
5. Click Finish session to save the effective time and title in your history.
   The timer clears so you can begin a new session.

You may change the title before finishing. An empty title is saved as
"Untitled session". Titles can contain up to 120 characters.
You can finish a running or paused session. A zero-length session cannot
be finished. Effective time is stored with millisecond precision; the
main stopwatch displays hours, minutes and seconds.

RESET
The circular arrow resets the current stopwatch and leaves its title in
place. A confirmation protects you from accidentally discarding study
time. Previously finished sessions are kept.

HISTORY AND TOTALS
Session history shows finished sessions with their title, finish date,
and effective study time. Search by title to find a previous session.
Export CSV exports all finished sessions for use in a spreadsheet.
The trash button deletes a single session after confirmation.
The timer page shows totals for today, this week (Monday to Sunday),
and all time. Totals include finished sessions only and use the local
calendar date on which each session was finished.
On smaller windows, the totals and recent sessions are hidden to leave
space for the stopwatch. All records remain available in Session history.

CLOSING AND REOPENING
Closing the app saves and pauses an unfinished session automatically.
On reopening, click Resume studying to continue it. Time while the app
is closed is excluded.
While running, the timer checkpoints approximately every five seconds.
After an unexpected crash or power loss, the last successful checkpoint
is restored paused. Up to five seconds since that checkpoint may be lost.
Time continues to count while the app is minimized or the computer is
asleep if you leave the stopwatch running. Pause it before your break.
Only one copy of Studytime runs at a time to protect your saved records.

KEYBOARD SHORTCUTS
Space       Start / pause / resume when outside a text field
Ctrl+Enter  Finish the current session
Ctrl+R      Reset the current session
Ctrl+H      Open session history
Ctrl+T      Open the study timer
Ctrl+Shift+T Toggle always on top
Ctrl+Shift+D Toggle dark / light mode
Tab         Move between fields and buttons
Enter       Activate the focused button

WHERE YOUR RECORDS ARE SAVED
Records stay on this Windows account, at:
%LOCALAPPDATA%\Studytime\sessions.json
The same folder contains sessions.json.bak, an automatic recovery backup.
Moving or replacing the executable does not remove your history.
For a separate backup, close Studytime and copy the entire Studytime data
folder somewhere safe. To restore it, close the app and replace the data
folder with your backup. The app also offers a CSV export for reading
your records; CSV import is not included.

SOURCE AND VERIFICATION
Studytime-Source.zip contains the complete C# source, embedded icon,
manifest, build script, and automated verification code.
To rebuild on a Windows computer with .NET Framework 4.8:
  powershell -ExecutionPolicy Bypass -File .\build.ps1
To run the verification checks from the build folder:
  Studytime.exe --self-test "C:\some\writable\folder\results.txt"
That test mode uses isolated data and never modifies your study records.
31 functional checks passed for the delivered executable. They cover
effective timing, pause/resume, reset, completion, recovery, persistent
storage, save failures, CSV output, and native interface controls. They
also verify the actual Windows topmost flag, compact window controls,
preference persistence, and compatibility with existing session files.
Dark-mode checks cover persistence, switching themes during study,
text readability, the history scrollbar, and compact window controls.
