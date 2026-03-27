# =============================================================================
# CodeTap — E2E Test Specification
# =============================================================================
#
# GLOBAL CONFIG:
#   Server URL:    http://localhost:${PORT:-3456}
#   Password:      value of CLAWTAP_PASSWORD env var
#   Browser:       agent-browser with mobile viewport (e.g. "iPhone 14")
#
# STEP DEFINITIONS:
#   "I open a new chat"
#     → Navigate to sessions view
#     → Pick any project (or use New Project to select a directory)
#     → Tap "New Chat" within that project
#
#   "I have an active chat session"
#     → Same as above, but a message has already been sent
#
# SCREENSHOT MARKERS: # [Screenshot: name.png]
#   → agent-browser should capture a screenshot at that point
#   → saved to tests/screenshots/<name>.png
#
# TIMELINE MARKERS: # T0, T1, T2...
#   → sequential state transitions within a scenario
#   → each T-point should be visually verified via screenshot
#   → wait for the described condition before capturing
#
# E2E DEFINITION:
#   E2E = "a user opens the mobile app and can see/do X".
#   If it requires checking server logs, API response shapes, file descriptors,
#   or settings.json — it's NOT E2E. Those are in the Appendix.
# =============================================================================


# =============================================================================
# CORE USER FLOWS
# =============================================================================

Feature: Authentication
  Background:
    Given the server is running
    And the browser is open to the app URL

  Scenario: Login with correct password
    When I navigate to the app
    Then I should see the login page with a password field
    # [Screenshot: login-page.png]
    When I enter the correct password
    And I tap "Login"
    Then I should be redirected to the sessions/projects view
    And the token should be stored in localStorage
    # [Screenshot: after-login.png]

  Scenario: Login with wrong password
    When I enter an incorrect password
    And I tap "Login"
    Then I should see an error message "Invalid password"
    And I should remain on the login page

  Scenario: Rate limiting after repeated failed attempts
    When I enter an incorrect password multiple times (server limit: 5 per minute)
    Then I should see "Too many login attempts. Try again later."
    And further login attempts should be rejected

  Scenario: Token persistence across page reload
    Given I am logged in
    When I reload the page
    Then I should still be on the sessions view (not login)

  Scenario: Logout clears session and returns to login
    Given I am logged in and viewing the projects list
    When I tap "Logout"
    Then I should be redirected to the login page
    And the token should be removed from localStorage
    When I reload the page
    Then I should see the login page (not sessions)


Feature: Session List & Project Navigation
  Background:
    Given I am logged in

  Scenario: View projects list
    Then I should see a list of projects grouped by working directory
    And each project should show a session count badge
    And projects should be sorted by most recent activity
    # [Screenshot: projects-list.png]

  Scenario: Navigate into a project
    When I tap on a project
    Then I should see the sessions within that project
    And each session should show the first prompt (truncated)
    And each session should show a relative timestamp (e.g. "3h ago")
    And a back button should appear in the header
    # [Screenshot: sessions-list.png]

  Scenario: Navigate back to projects
    Given I am viewing sessions within a project
    When I tap the back button
    Then I should return to the projects list

  Scenario: Start new chat within a project
    Given I am viewing sessions within a project
    When I tap "New Chat"
    Then a new empty chat should open
    And the header should show the project name
    And "Send a message to start" should appear in the chat area
    And the send button should be disabled

  Scenario: Start new chat with directory browser
    When I tap "New Project"
    Then a directory browser modal should appear
    And it should show directories under the home folder
    # [Screenshot: directory-browser.png]
    When I select a directory
    Then a new chat should open with that directory as cwd

  Scenario: Navigate directories in directory browser
    Given the directory browser is open at the home folder
    When I tap a folder (e.g. "Documents")
    Then the browser should show the contents of that folder
    And the breadcrumb should update to show "~ / Users / name / Documents"
    When I tap "~" in the breadcrumb
    Then the browser should return to the home folder

  Scenario: Tab bar with Projects and Active tabs
    When I view the projects list
    Then I should see a tab bar with "Projects" and "Active (N)" tabs
    And "Projects" should be selected by default
    When I tap "Active (N)"
    Then the Active tab should be selected (highlighted with accent color)

  Scenario: Active tab shows running sessions
    Given I have 2 active chat sessions (tmux running)
    When I tap the "Active" tab
    Then I should see 2 session rows, each with:
      | Element          | Description                                      |
      | Green dot        | Filled green circle (bg-green-500, 8px)           |
      | First prompt     | Truncated first user message (or session UUID)    |
      | Time             | Relative timestamp from lastActivity (e.g. "3m")  |
      | Project name     | Short directory name (e.g. "code-tap")            |
      | Permission mode  | "Normal", "YOLO", "Auto-edit", or "Plan"          |
      | Client count     | 👤N shown only when clients are connected         |
    When I tap an active session row
    Then I should enter the chat view for that session

  Scenario: Active tab auto-refreshes every 3 seconds
    Given I am viewing the Active tab
    When I wait 3 seconds
    Then the active sessions list should refresh automatically
    And the session count in "Active (N)" should update

  Scenario: Active tab empty state
    Given no sessions are currently running
    When I tap the "Active" tab
    Then I should see "No active sessions"
    And a "Refresh" button should be visible

  Scenario: Green dot on active sessions in project drill-down
    Given I have an active chat session in the "code-tap" project
    When I drill into the "code-tap" project from the Projects tab
    Then the active session should show a green dot before its title
    And non-active (historical) sessions should NOT have a green dot

  Scenario: Session ends and disappears from Active tab
    Given I have an active session visible in the Active tab
    When the Claude CLI session terminates
    Then the session should disappear from the Active tab on next refresh
    And the green dot should disappear from the project drill-down

  Scenario: Session list loads quickly (getSessions optimization)
    # Regression: previously parsed ALL session headers before sorting
    Given there are 100+ session files
    When I load the sessions list
    Then the list should appear within 3 seconds
    And sessions should be sorted by most recently modified


Feature: Chat — Send & Receive Messages
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Empty chat view shows correct initial state
    When I open a new chat
    Then "Send a message to start" should appear in the center
    And the StatusBar should show model name and permission mode
    And the input placeholder should say "Send a message..."
    And the send button should be disabled
    And the image upload button should be visible

  Scenario: Send button disabled when input is empty
    Given I am in an empty chat
    Then the send button should be disabled (grayed out)
    When I type any text in the input field
    Then the send button should become enabled
    When I clear all text from the input field
    Then the send button should be disabled again

  Scenario: Send a message and receive response
    # --- Timeline: Message Lifecycle ---
    # T0: Input ready
    Then I should see the input field with placeholder "Send a message..."
    # [Screenshot: T0-empty-chat.png]

    When I type "Say hello in one sentence"
    And I tap the send button
    # T1: User message appears immediately (optimistic)
    Then I should see my message in a blue bubble on the right
    And the input field should be cleared
    And a streaming indicator should appear ("Working...")
    # [Screenshot: T1-user-message-sent.png]

    # T2: Streaming text preview appears
    Then within 10 seconds I should see streaming text preview
    And the indicator should change to "Responding..."
    # [Screenshot: T2-streaming-preview.png]

    # T3: Thinking indicator (if model thinks)
    # Note: may or may not appear depending on query complexity
    # If visible: shows spinner + verb (e.g. "Thinking…")
    # [Screenshot: T3-thinking-indicator.png — if visible]

    # T4: Final message appears
    Then within 30 seconds the streaming indicator should disappear
    And I should see the assistant's response in a dark bubble on the left
    And the response should contain rendered markdown
    # [Screenshot: T4-response-complete.png]

  Scenario: Streaming text preview shows live response
    When I send a message and Claude begins responding
    Then a streaming text preview should appear below the thinking indicator
    And the preview text should update in real-time as Claude writes
    And the preview should be line-clamped (max 3 lines visible)
    When the response completes
    Then the streaming preview should disappear
    And the full response should appear as a message bubble

  Scenario: Markdown rendering in responses
    When I send "Show me a code block in Python and a bullet list"
    Then the response should contain:
      | Element         | Rendered As                        |
      | Code block      | Syntax-highlighted block (oneDark) |
      | Bullet list     | Proper list with bullet markers    |
      | Inline code     | Monospace with background          |

  Scenario: Session ID assigned after first message
    When I send my first message
    Then the header should update to show the project name
    Then the header should show the CLI UUID (truncated, e.g. "625c60d0-aedb...")
    And a copy icon should appear next to the CLI UUID
    And the session ID should be a CLI UUID format (e.g. "d6d56787-bfaf-4312...")
    When I tap the copy icon
    Then the full CLI UUID should be copied to clipboard

  Scenario: Chat auto-scrolls to latest message
    Given I have a long conversation that fills the screen
    When a new assistant message arrives
    Then the chat should auto-scroll to show the latest message

  Scenario: Scroll position preserved when user scrolls up
    Given I have manually scrolled up to read earlier messages
    When a new message arrives
    Then my scroll position should NOT jump to the bottom


# =============================================================================
# TOOL & PERMISSION FLOWS
# =============================================================================

Feature: Tool Calls — Display & Status
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Tool execution lifecycle
    # --- Timeline: Tool Status Transitions ---
    When I send "Read the file package.json"

    # T1: Tool card appears with "running" status
    Then a tool card should appear with name "Read"
    And the card should show the file path "package.json"
    And the status should show a spinning loader
    # [Screenshot: T1-tool-running.png]

    # T2: Tool completes
    Then within 15 seconds the tool status should change to a green checkmark
    # [Screenshot: T2-tool-success.png]

    # T3: Response with tool result
    Then the assistant should reference the file contents in its response

  Scenario: Edit tool with diff preview
    When I send "Add a comment '// entry point' to the top of src/index.js"
    Then a tool card for "Edit" should appear
    When the tool completes
    And I tap the tool card to expand it
    Then I should see a diff view with red (removed) and green (added) lines
    # [Screenshot: tool-edit-diff.png]

  Scenario: View full diff in full-screen viewer
    Given an Edit tool card has completed
    When I tap the tool card to expand it
    Then I should see a diff preview with red/green lines
    When I tap "View full diff"
    Then a full-screen DiffViewer modal should open
    And it should show the file path in the header
    And line numbers should be visible
    And removed lines should have red background
    And added lines should have green background
    # [Screenshot: diff-viewer-fullscreen.png]
    When I tap the X button
    Then the modal should close

  Scenario: Multiple tools in sequence
    When I send "Read src/index.js and src/utils.js, then describe them"
    Then multiple tool cards should appear in order
    And each should transition from running → success independently
    # [Screenshot: multiple-tools.png]

  Scenario: Subagent group display
    When I send a request that spawns an Agent tool with subtasks
    Then I should see a collapsible "Agent" card
    And it should show completion count (e.g. "1 of 3 agents running")
    When I expand the agent card
    Then I should see the individual subtool cards inside
    # [Screenshot: subagent-group.png]

  Scenario: Tool error display
    When a tool execution fails
    Then the tool card should show a red X icon
    And the status should be "error"
    # [Screenshot: tool-error.png]

  Scenario: Known tools show specific descriptions
    When a "Read" tool card appears with file_path "src/index.ts"
    Then the card summary should show "src/index.ts"

    When a "WebFetch" tool card appears with url "https://example.com"
    Then the card summary should show "https://example.com"

    When a "WebSearch" tool card appears with query "react hooks"
    Then the card summary should show "react hooks"

  Scenario: Unknown tools show first input value
    When a custom MCP tool "mcp__myserver__query" appears
    And its input contains {"query": "SELECT * FROM users", "limit": 10}
    Then the card summary should show "SELECT * FROM users"
    # Fallback: first non-empty string value from input


Feature: Permission System
  Background:
    Given I am logged in
    And permission mode is set to "Normal"
    And I open a new chat

  Scenario: Permission overlay shows 3 vertically stacked options
    When I send "Create a file called test.txt with hello world"
    # --- Timeline ---
    # T0: User message sent
    # T+1s: Tool card appears with "Write" tool (Loading spinner)
    # T+2s: Permission overlay slides up from bottom
    Then a permission overlay should appear from the bottom
    And it should show the tool name and input details
    And it should display 3 vertically stacked buttons:
      | Position | Button                        | Style          |
      | Top      | Allow                         | Green/primary  |
      | Middle   | Allow all for this command    | Secondary      |
      | Bottom   | Deny                          | Ghost          |
    And a countdown timer should show (starting at 120s)
    # [Screenshot: T2-permission-overlay-3-options.png]

  Scenario: Allow — tool executes and completes
    Given a permission overlay is showing for Write /tmp/test.txt
    # T0: User taps "Allow"
    When I tap "Allow"
    # T+0.5s: CLI selects "Yes", overlay dismisses on mobile
    Then the permission overlay should dismiss
    # T+1s: CLI executes the tool
    # T+2s: PostToolUse fires → tool card transitions to Complete
    And the tool card should show Complete (green ✓)
    And the file /tmp/test.txt should exist
    And Claude's response should appear
    # [Screenshot: T0-permission-allow-tap.png]
    # [Screenshot: T2-permission-allow-complete.png]
    # Verify: tool card did NOT revert to Loading after Allow

  Scenario: Allow all — auto-approve future same-type tools
    Given a permission overlay is showing for Write /tmp/test2.txt
    # T0: User taps "Allow all for this command"
    When I tap "Allow all for this command"
    # T+0.5s: CLI selects "Yes, allow all...", switches to accept-edits mode
    Then the permission overlay should dismiss
    And the file /tmp/test2.txt should exist
    # [Screenshot: T0-allow-all-tap.png]
    # T+5s: Claude uses another Write tool
    When Claude uses another Write tool
    Then the tool should auto-approve WITHOUT showing a permission overlay
    And the tool card should transition directly to Complete
    # [Screenshot: T5-auto-approve-no-overlay.png]
    # Note: "Allow all" activates CLI's per-command auto-approve for this session
    # It does NOT change the mobile permission mode selector (still shows "Normal")

  Scenario: Deny — tool rejected, file not created
    Given a permission overlay is showing for Write /tmp/deny.txt
    # T0: User taps "Deny"
    When I tap "Deny"
    # T+0.5s: CLI shows "User rejected"
    Then the permission overlay should dismiss
    And /tmp/deny.txt should NOT exist
    And Claude should acknowledge the denial in its response
    # [Screenshot: T0-deny-tap.png]
    # [Screenshot: T1-deny-result.png]

  Scenario: Permission overlay timeout — auto-dismiss after 2 minutes
    Given a permission overlay is showing
    When I wait without responding for 2 minutes
    Then the mobile overlay should auto-dismiss
    # Note: Timeout dismisses the MOBILE overlay only.
    # The CLI terminal prompt remains active. Desktop user can still answer.
    # If neither answers, CLI eventually times out on its own.

  Scenario: Permission for Agent subtool — overlay appears inline
    Given Claude is running an Agent
    And the Agent uses a Bash subtool that requires permission
    # T0: Agent card appears (Loading)
    # T+1s: Bash subtool starts → PreToolUse fires
    # T+2s: PermissionRequest fires → permission overlay appears
    Then the permission overlay should show the Bash command
    # [Screenshot: T2-agent-subtool-permission.png]
    When I tap "Allow"
    # T+3s: Subtool executes → PostToolUse fires → subtool Complete
    Then the subtool card should transition to Complete
    And the Agent card should remain in Loading (Agent still working)
    # [Screenshot: T3-agent-subtool-approved.png]

  Scenario: Permission approved — no state corruption on other tools
    Given Claude uses Read (auto-approved), then Write (needs permission), then Bash
    # T0: Read tool starts → auto-approved → Complete
    # T+1s: Write tool starts → permission overlay appears
    # T+3s: User taps Allow → Write completes
    # T+4s: Bash tool starts
    Then Read tool card should remain Complete throughout
    And Write tool card should go Loading → Permission → Complete
    And Bash tool card should show Loading → Complete
    And no tool card should revert status at any point
    # [Screenshot: T0-read-complete.png]
    # [Screenshot: T1-write-permission.png]
    # [Screenshot: T3-write-complete.png]
    # [Screenshot: T4-bash-loading.png]

  Scenario: AskUserQuestion — select option
    When Claude uses AskUserQuestion with options ["Yes", "No", "Maybe"]
    Then a question panel should appear (not the permission overlay)
    And it should show the question text
    And it should list 3 selectable option buttons
    And it should have an "Other..." button
    # [Screenshot: ask-question-panel.png]
    When I tap "Yes"
    Then the panel should change to show "Question answered"
    And the response "Yes" should be sent to Claude

  Scenario: AskUserQuestion — free-form response
    Given a question panel is showing
    When I tap "Other..."
    Then a text input should appear with placeholder "Type your answer..."
    When I type "Custom answer" and press Enter
    Then the panel should change to show "Question answered"
    And the response "Custom answer" should be sent to Claude


Feature: Permission Mode Switching (Mid-Session)
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Cycle permission modes in StatusBar
    # --- Timeline: Mode Cycling ---
    # T0: Default mode
    Then the StatusBar should show "Normal" as the permission mode
    # [Screenshot: T0-mode-normal.png]

    When I tap the permission mode label
    Then it should cycle to "Auto-edit"
    # [Screenshot: T1-mode-auto-edit.png]

    When I tap again
    Then it should cycle to "Plan"
    # [Screenshot: T2-mode-plan.png]

    When I tap again
    Then it should cycle to "YOLO"
    # [Screenshot: T3-mode-yolo.png]

    When I tap again
    Then it should cycle back to "Normal"

  Scenario: YOLO mode auto-allows all tools
    Given I set permission mode to "YOLO"
    When I send "Create a file called yolo-test.txt"
    Then the tool should execute without showing a permission overlay
    And the tool card should go directly from running to success

  Scenario: Switch to YOLO while permission overlay is showing
    Given permission mode is "Normal"
    And a permission overlay is currently showing
    When I tap the mode label to switch to "YOLO"
    Then the permission overlay should dismiss immediately
    And the pending tool should proceed (allowed)
    # [Screenshot: mode-switch-dismisses-overlay.png]

  Scenario: Plan mode handled by CLI natively
    Given I set permission mode to "Plan"
    When I send "Create a file called plan-test.txt"
    Then Claude CLI should handle plan mode restrictions natively
    And the permission request should pass through to the terminal
    # Note: CodeTap no longer auto-denies in plan mode — CLI enforces its own restrictions

  Scenario: Auto-edit mode allows edits but asks for Bash
    Given I set permission mode to "Auto-edit"
    When Claude tries to use the "Edit" tool
    Then it should auto-allow without showing permission overlay
    When Claude tries to use the "Bash" tool
    Then a permission overlay should appear

  Scenario: Mode persists for resumed sessions
    # Regression: resumeSession previously hardcoded --dangerously-skip-permissions
    Given I set permission mode to "Normal"
    And I close and reopen the app
    When I open the same session
    Then the mode should still be "Normal"
    And permission requests should still appear


Feature: Interrupt / Abort
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Interrupt during streaming response
    # --- Timeline: Interrupt Flow ---
    When I send "Write a very long essay about the history of computing"

    # T1: Streaming begins
    Then I should see the streaming indicator
    And a stop button should appear (replacing the send button)
    # [Screenshot: T1-streaming-with-stop.png]

    # T2: User taps stop
    When I tap the stop button

    # T3: Immediate UI feedback
    Then the streaming indicator should disappear immediately
    And any running tool cards should show the interrupted icon (ban/circle)
    # [Screenshot: T3-interrupted-immediate.png]

    # T4: Interrupt marker appears from server
    Then within 5 seconds an interrupt marker should appear:
      "⎿ Interrupted · What should Claude do instead?"
    And the input placeholder should change to "What should Claude do instead?"
    # [Screenshot: T4-interrupt-marker.png]

  Scenario: Interrupt during tool execution
    When I send "Run ls -la in the project directory"
    And the tool card shows "running"
    When I tap the stop button
    Then the tool card should immediately show the interrupted icon (not success)
    # Regression: previously showed success icon before abort processed
    # [Screenshot: tool-interrupted.png]

  Scenario: Send follow-up after interrupt
    Given I interrupted the previous response
    When I type "Instead, just say hi" and send
    Then a new user message should appear
    And Claude should respond with a new message
    And the interrupt marker should remain in history

  Scenario: Interrupt detection in session history
    # Regression: previously didn't detect interrupts when loading old sessions
    Given a session has interrupt markers in its JSONL history
    When I open that session
    Then the interrupt markers should render as "⎿ Interrupted..." (not as user messages)


# =============================================================================
# ADVANCED FEATURES
# =============================================================================

Feature: StatusBar — Model & Context
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Cycle models in StatusBar
    Then the StatusBar should show the current model (default: "Opus 1M")
    When I tap the model label
    Then it should cycle to the next model
    And the new model should be persisted for the next message

  Scenario: Context usage display from statusline
    # --- Timeline: Context % Updates ---
    # T0: No context data yet
    Then the StatusBar should NOT show a context progress bar
    # [Screenshot: T0-no-context.png]

    When I send a message and receive a response
    # T1: Statusline hook fires with context data
    Then the StatusBar should show a context usage percentage
    And a progress bar should appear (green if <50%)
    # [Screenshot: T1-context-shown.png]

    When I send several more messages
    # T2: Context grows
    Then the percentage should increase
    And the bar color should change:
      | Percentage | Color  |
      | 0-50%      | Green  |
      | 50-80%     | Yellow |
      | 80-100%    | Red    |
    # [Screenshot: T2-context-growing.png]

  Scenario: Compacting status in UI
    Given I have an active chat session with high context usage
    When Claude compacts the conversation context
    Then the mobile UI should show "Compacting context..." as the thinking status
    # Note: No explicit "compaction done" event — the thinking status is replaced
    # when the next event arrives (tool-start, text-delta, etc.)


Feature: Image Upload
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Upload and send image with message
    When I tap the image upload button
    And I select an image file
    Then a thumbnail preview should appear near the input
    # [Screenshot: image-thumbnail-preview.png]
    When I type "What is in this image?" and send
    Then the message should be sent with the image reference
    And Claude should respond about the image content

  Scenario: Remove image before sending
    Given I have selected an image (thumbnail visible)
    When I tap the remove button on the thumbnail
    Then the thumbnail should disappear
    And I can send a text-only message

  Scenario: Paste image from clipboard
    Given I am in a chat session
    When I paste an image from the clipboard (Ctrl+V / Cmd+V)
    Then a thumbnail preview should appear near the input
    And I should be able to send the message with the pasted image


Feature: Plan Mode UI
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: EnterPlanMode shows plan card inline
    When Claude enters plan mode (EnterPlanMode tool)
    Then a plan card should appear inline in the chat messages
    And the card should show truncated plan text (max 500 chars)
    And "Approve", "Reject", and "Approve (YOLO)" buttons should be visible
    And the input area should remain active for feedback
    # [Screenshot: plan-mode-card.png]

    When I tap "Approve"
    Then an approval message should be sent to Claude
    And Claude should proceed with implementation

  Scenario: Reject plan with feedback
    Given a plan card is showing
    When I tap "Reject"
    Then a text input should appear for feedback
    When I type "Use a different approach" and submit
    Then a rejection message with feedback should be sent

  Scenario: ExitPlanMode shows collapsible plan document
    When Claude exits plan mode with a plan document
    Then a collapsed plan card should appear with the plan title
    And it should show a "View" button
    When I tap "View"
    Then a full-screen plan viewer should open with rendered markdown
    And a close (X) button should appear in the top corner
    # [Screenshot: plan-fullscreen.png]
    When I tap the X button
    Then the viewer should close and return to chat

  Scenario: Approve plan with YOLO mode
    Given a plan card is showing with Approve buttons
    When I tap "Approve (YOLO)"
    Then permission mode should switch to "YOLO" (bypassPermissions)
    And the plan should be approved
    And subsequent tools should auto-execute without permission prompts

  Scenario: Send feedback during plan review
    Given a plan card is showing
    When I type feedback text in the input field
    And I tap the send feedback button
    Then the feedback should be sent as a message to Claude
    And Claude should incorporate the feedback


Feature: Message Queuing
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Queue message during streaming
    # --- Timeline: Queue Lifecycle ---
    When I send "Tell me about React"
    # T0: Streaming
    Then the stop button should be visible

    When I type "Also tell me about Vue" and tap send
    # T1: Message queued
    Then a queued message bubble should appear
    And it should show a "Queued" badge
    And it should show the queued text
    And "Edit" and "Cancel" buttons should appear
    # [Screenshot: T1-queued-message.png]

    # T2: First response completes
    Then when the first response finishes
    # T3: Queued message auto-sends
    Then the queued message should automatically send
    And it should appear as a regular user message
    # [Screenshot: T3-queue-drained.png]

  Scenario: Edit queued message
    Given a message is queued
    When I tap "Edit"
    Then the queued text should appear in the input field
    And the queued message bubble should disappear

  Scenario: Cancel queued message
    Given a message is queued
    When I tap "Cancel"
    Then the queued message should disappear
    And nothing should send when the current response completes


Feature: Task Progress (TodoWrite)
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: View task progress
    When Claude uses TodoWrite with a list of tasks
    Then a task progress card should appear
    And it should show a completion percentage
    And each task should show its status:
      | Status      | Icon                     |
      | pending     | Empty circle             |
      | in_progress | Filled circle            |
      | completed   | Checkmark (strikethrough)|
    # [Screenshot: task-progress.png]


Feature: Shimmer Input (Ultra-Think Keywords)
  Background:
    Given I am logged in and in a chat

  Scenario: Shimmer animation on ultra-think keywords (keyword-only)
    When I type "ultrathink"
    Then ONLY the word "ultrathink" should have a shimmer animation effect
    And the rest of the input should render as normal text
    # [Screenshot: shimmer-keyword-only.png]

    When I clear the text and type "please megathink about this"
    Then ONLY the word "megathink" should shimmer
    And "please " and " about this" should be normal text

    When I clear and type "think harder now"
    Then ONLY "think harder" should shimmer
    And " now" should be normal text

    When I clear and type "normal message"
    Then there should be no shimmer effect on any text

    When I clear and type "ultrathink and also megathink"
    Then both "ultrathink" and "megathink" should shimmer
    And " and also " should be normal text


# =============================================================================
# RESILIENCE & PERSISTENCE
# =============================================================================

Feature: WebSocket Connection & Keepalive
  Background:
    Given I am logged in

  Scenario: Connection lifecycle
    # --- Timeline: Connection States ---
    When I open the app
    # T0: Connecting
    Then the WebSocket should be in "connecting" state

    # T1: Connected
    Then within 2 seconds it should transition to "connected"

  Scenario: Reconnection on disconnect
    Given I have an active chat session with messages
    When the WebSocket connection drops
    # T0: Disconnected
    Then "Reconnecting..." should appear in the header
    # [Screenshot: T0-reconnecting.png]

    # T1: Auto-reconnect (exponential backoff: 1s, 2s, 4s...)
    Then within 5 seconds the connection should be re-established

    # T2: Session history reloaded
    Then all previous messages should still be visible
    And the conversation should be in the correct state
    # [Screenshot: T2-reconnected-with-history.png]

  Scenario: Reconnect to active session
    Given Claude is currently streaming a response
    When the WebSocket disconnects and reconnects
    Then the session should resume
    And new messages should continue appearing

  Scenario: WS connection survives long thinking period (60+ seconds)
    Given mobile is connected to a session in ChatView
    When Claude is thinking for 60+ seconds (e.g., deep analysis with high effort)
    # T0: User sends message
    # T+5s: Thinking indicator appears
    # T+30s: Server ping/pong keeps connection alive
    # T+60s: Another ping/pong cycle
    # T+65s: Claude starts responding
    Then the WebSocket connection should remain open throughout
    And the thinking indicator should update continuously
    And when the response arrives, it should stream normally
    # [Screenshot: T65-response-after-long-think.png]
    # Previously: WS disconnected after ~30s idle, losing all real-time updates

  Scenario: WS connection survives Agent execution (60+ seconds)
    Given mobile is connected to a session in ChatView
    When Claude runs an Agent that executes 10+ subtools over 90 seconds
    # T0: Agent starts
    # T+30s: ping/pong keeps connection alive
    # T+60s: ping/pong again
    # T+90s: Agent completes
    Then the WS connection should remain open for the entire duration
    And tool cards should update in real-time (Loading → Complete)
    And the final response should stream to mobile
    # [Screenshot: T90-agent-complete-after-keepalive.png]


Feature: Session Resume & History
  Background:
    Given I am logged in

  Scenario: Resume an old session with full history
    Given I previously had a conversation with multiple messages
    When I open that session from the session list
    # T0: Loading
    Then I should see the session loading

    # T1: History loaded
    Then all previous messages should appear in order
    And user messages should be on the right (blue)
    And assistant messages should be on the left (dark)
    And interrupt markers should render correctly
    And plan cards should render correctly
    # [Screenshot: T1-session-history.png]

    # T2: Ready for new input
    Then the input field should be ready for a new message
    When I send a new message
    Then it should continue the conversation

  Scenario: Session reconnect preserves scroll position
    Given I am viewing a long conversation
    And I have scrolled up in the message list
    When the WebSocket reconnects
    Then my scroll position should be preserved
    And new messages should not force-scroll to bottom


Feature: Session Persistence
  Background:
    Given I am logged in

  Scenario: Session survives client disconnect
    Given I have an active chat session from mobile
    When I close the mobile browser tab
    And I wait 60 seconds
    Then the tmux window should still be running
    When I reopen the mobile app and navigate to the session
    Then the session should still be active
    And all messages should be preserved
    And I should be able to send new messages


Feature: Offline Detection & Mascot
  The app detects server unreachability via health polling and shows
  an offline screen with a sleeping mascot cat.

  Background:
    Given I am logged in

  Scenario: App shows loading mascot during initial connection
    When I open the app for the first time
    # T0: App starts, health check pending
    Then a loading animation should appear with a floating cat mascot (idle state)
    And a "Connecting..." label should pulse below the mascot
    # [Screenshot: T0-loading-mascot-idle.png]

    # T1: Health check passes
    Then the mascot should disappear
    And the sessions view should load
    # [Screenshot: T1-sessions-loaded.png]

  Scenario: Offline view appears when server is unreachable
    Given the server has stopped (e.g., codetap process killed)
    # T0: Health polling fails (2 consecutive failures, 15s interval)
    # T+30s: Offline view appears
    Then an OfflineView should replace the current view
    And it should show a sleeping cat mascot (sleep state)
    And it should show the "codetap" command for restarting
    And a "Retry" button should be visible
    # [Screenshot: T30-offline-view-sleeping-cat.png]

  Scenario: Retry button reconnects to server
    Given the offline view is showing
    And the server has been restarted
    When I tap "Retry"
    Then the app should attempt to reconnect
    And the loading mascot should appear (idle state)
    And within 5 seconds the sessions view should load
    # [Screenshot: retry-reconnected.png]

  Scenario: ChatView shows "Reconnecting..." during temporary disconnect
    Given I am in ChatView with an active session
    When the server becomes temporarily unreachable
    Then "Reconnecting..." should appear in the ChatView header
    And the chat messages should remain visible (not replaced by offline view)
    When the server becomes reachable again
    Then "Reconnecting..." should disappear
    And the session should resume normally
    # [Screenshot: chatview-reconnecting-header.png]

  Scenario: Browser offline event triggers reconnection attempt
    Given I am using the app on a mobile device
    When the device loses internet connection (airplane mode)
    Then the app should detect the offline state
    And "Reconnecting..." should appear
    When internet is restored
    Then the app should automatically reconnect


# =============================================================================
# STREAMING & MONITORING
# =============================================================================

Feature: Streaming Text Pipeline
  PaneMonitor captures tmux pane content, extracts response text,
  and streams it to mobile as TEXT_DELTA events via WebSocket.

  Background:
    Given a Claude session is active
    And mobile is connected to the session in ChatView

  Scenario: Response text streams incrementally to mobile
    When Claude generates a 500+ word response
    # T0: User message sent
    # T+2s: Thinking indicator appears
    # T+5s: Claude starts writing response
    # T+5.5s: First streaming text visible on mobile (~50 chars)
    # T+6.0s: More text appears (~200 chars)
    # T+6.5s: More text (~350 chars)
    # ...continues every ~500ms...
    # T+12s: Response complete → streaming stops
    Then text should appear incrementally on mobile (not all at once)
    And each update should show more text than the previous
    And the final complete message should match the streamed content
    # [Screenshot: T5-streaming-start.png] (first ~50 chars visible)
    # [Screenshot: T7-streaming-mid.png] (200+ chars visible)
    # [Screenshot: T10-streaming-near-end.png] (full text forming)
    # [Screenshot: T12-streaming-complete.png] (final state)

  Scenario: Streaming works correctly after context compaction
    Given Claude is in a long session with high context usage
    When context compaction occurs (StatusBar shows "Compacting context...")
    And the next user message triggers a response
    Then the new response should stream fresh content
    And old response text should NOT leak into the new stream
    And the streaming preview should show only the latest response
    # [Screenshot: post-compaction-streaming.png]

  Scenario: Streaming shows only the latest response (multi-prompt session)
    Given the user has sent 5+ prompts with responses
    When the user sends a new message and Claude responds
    Then the streaming preview should show ONLY the new response text
    And it should NOT include text from earlier responses
    # Previously: PaneMonitor found first ⏺ marker instead of last, mixing old responses


Feature: SubagentStop — Streaming Preservation
  When a subagent (Agent tool) completes, PaneMonitor stays active
  and the parent session's response continues to stream.

  Background:
    Given a Claude session is active
    And mobile is connected in ChatView

  Scenario: Response streams after Agent subtools complete
    When Claude is running an Agent with subtools (Read, Bash, etc.)
    # T0: Agent card appears (Loading)
    # T+2s: Subtools execute, sub-tool cards show Loading → Complete
    # T+5s: Agent subtools finish, Agent generates final response text
    # T+6s: Response text starts streaming to mobile
    # T+8s: More text appears
    # T+10s: Response complete
    Then after the Agent's subtools finish, response text should still stream to mobile
    And the text should appear incrementally (not all at once when turn ends)
    And tool cards should remain in their final status (not reset)
    # [Screenshot: T5-subtools-done-streaming-starts.png]
    # [Screenshot: T8-streaming-after-subagent.png]
    # [Screenshot: T10-response-complete.png]
    # Previously: SubagentStop killed the streaming monitor, text appeared all at once

  Scenario: No premature turn completion after Agent subtools finish
    When Claude runs an Agent that completes its subtools
    Then the mobile should NOT show "turn complete" state prematurely
    And subsequent tool events should appear normally (Loading → Complete)
    And new tool cards should NOT be discarded
    When the final response is complete
    Then the turn should end normally
    # Previously: premature TURN_COMPLETE caused tool cards to be discarded

  Scenario: Multiple nested agents — each completes independently
    Given Claude spawns Agent A which spawns Agent B
    # T0: Agent A card appears (Loading)
    # T+3s: Agent B card appears nested under A (Loading)
    # T+8s: Agent B completes → B's card shows Complete
    # T+10s: Agent A continues with more work
    # T+15s: Agent A completes → A's card shows Complete
    # T+18s: Final response streams
    When Agent B completes
    Then Agent A should continue working (card still Loading)
    And streaming should remain active
    When Agent A completes
    Then the final response should stream normally
    When the turn ends
    Then all tool cards should show Complete
    # [Screenshot: T8-agent-b-complete.png]
    # [Screenshot: T10-agent-a-still-working.png]
    # [Screenshot: T18-all-complete.png]


# =============================================================================
# INTEGRATION TEST
# =============================================================================

Feature: Cross-Feature Timeline — Full Chat Lifecycle
  # This scenario tests the complete lifecycle of a chat session
  # with explicit screenshot points at each state transition.
  # It exercises: chat, tools, permissions, interrupt, mode switching,
  # context display, and session persistence in a single flow.

  Scenario: Complete chat lifecycle with tools, permissions, and interrupt
    Given I am logged in
    And permission mode is "Normal"

    # === Phase 1: New Chat ===
    When I tap "New Chat" on a project
    Then I should see an empty chat view
    # [Screenshot: lifecycle-01-empty-chat.png]

    # === Phase 2: First Message ===
    When I send "Create a hello.txt file with 'Hello World'"
    Then my message appears immediately
    # [Screenshot: lifecycle-02-message-sent.png]

    # === Phase 3: Streaming ===
    Then streaming indicator appears
    # [Screenshot: lifecycle-03-streaming.png]

    # === Phase 4: Tool Start ===
    Then a "Write" tool card appears with running status
    # [Screenshot: lifecycle-04-tool-running.png]

    # === Phase 5: Permission Request (Non-Blocking) ===
    Then permission overlay slides up with 3 options: Allow, Allow all, Deny
    # Note: CLI terminal also shows its own permission prompt simultaneously
    # Mobile overlay and desktop terminal can both answer — first response wins
    # [Screenshot: lifecycle-05-permission-overlay.png]

    # === Phase 6: Permission Granted ===
    When I tap "Allow"
    Then overlay dismisses, tool proceeds
    # [Screenshot: lifecycle-06-permission-allowed.png]

    # === Phase 7: Tool Complete ===
    Then tool card shows success (green checkmark)
    # [Screenshot: lifecycle-07-tool-success.png]

    # === Phase 8: Response Complete ===
    Then assistant response appears, streaming stops
    And StatusBar shows context usage percentage
    # [Screenshot: lifecycle-08-response-complete.png]

    # === Phase 9: Second Message (Trigger Interrupt) ===
    When I send "Now write a very long essay about this file"
    Then streaming begins again
    # [Screenshot: lifecycle-09-streaming-again.png]

    # === Phase 10: Interrupt ===
    When I tap the stop button
    Then streaming stops, interrupt marker appears
    And any running tools show interrupted status
    # [Screenshot: lifecycle-10-interrupted.png]

    # === Phase 11: Follow-up After Interrupt ===
    When I send "Just describe what you would have written"
    Then conversation continues normally
    # [Screenshot: lifecycle-11-follow-up.png]

    # === Phase 12: Mode Switch ===
    When I tap the permission mode to switch to "YOLO"
    Then StatusBar updates to show "YOLO"
    # [Screenshot: lifecycle-12-mode-yolo.png]

    # === Phase 13: Tool Without Permission (YOLO) ===
    When I send "Read package.json"
    Then the tool executes without permission overlay
    # [Screenshot: lifecycle-13-yolo-no-permission.png]

    # === Phase 14: Close & Reopen ===
    When I go back to the session list
    Then this session should appear at the top (most recent)
    # [Screenshot: lifecycle-14-session-in-list.png]

    When I tap the session to reopen it
    Then all messages, tools, and interrupts should be preserved
    # [Screenshot: lifecycle-15-reopened-session.png]


# =============================================================================
# DESKTOP ↔ MOBILE SYNC & SESSION MANAGEMENT
# =============================================================================
# These scenarios test bidirectional sync between the desktop CLI (via tmux)
# and the mobile UI (via agent-browser). They require both tmux commands
# and browser interaction.
#
# STEP DEFINITIONS:
#   "I type <text> in the desktop terminal"
#     → tmux send-keys -t codetap:<window> -l "<text>" Enter
#
#   "I start a desktop session"
#     → run `codetap` in a terminal (creates tmux window + Claude CLI)
#
#   "I start a desktop session with /resume"
#     → in existing Claude CLI, type `/resume` and select a session
#     → OR run `codetap --resume <session-id>`

Feature: Desktop ↔ Mobile — Session Discovery
  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: Desktop new session appears in Active tab (A1)
    When I start a desktop session via `codetap`
    And I type "Hi" in the desktop terminal
    Then within 10 seconds the Active tab should show the new session
    And it should display the first prompt "Hi" (not a UUID)
    And it should show the project name and permission mode
    # [Screenshot: sync-A1-desktop-session-in-active.png]

  Scenario: Mobile new session creates tmux window (A2)
    When I tap "New Chat" on a project
    And I send "Hello from mobile"
    Then a new tmux window should appear in the codetap session
    And the Active tab should show this session
    # [Screenshot: sync-A2-mobile-creates-tmux.png]

  Scenario: Desktop /resume makes old session active (A3)
    Given I have a historical session in the Projects tab
    When I type `/resume` in the desktop Claude CLI and select that session
    Then within 10 seconds the Active tab should show the resumed session
    And it should display the correct firstPrompt from the old session
    # [Screenshot: sync-A3-resume-in-active.png]

  Scenario: CLI codetap --resume creates mapped session (A4)
    Given I have a historical session with a known session ID
    When I run `codetap --resume <session-id>` in a new terminal
    # tmux windows follow {adapter}-{timestamp} naming: claude-1774210269126, codex-1774210345678
    Then a new tmux window named "{adapter}-{timestamp}" should be created
    And within 10 seconds the Active tab should show this session
    # [Screenshot: sync-A4-cli-resume.png]

  Scenario: Multiple active sessions displayed (A5)
    When I start 3 desktop sessions via `codetap` in separate windows
    And each sends a different first message
    Then the Active tab should show all 3 sessions
    And each should display its own firstPrompt
    # [Screenshot: sync-A5-multiple-active.png]

  Scenario: Second terminal detects running server (A6)
    Given the server is already running (started by first `codetap`)
    When I run `codetap` in a new terminal WITHOUT CLAWTAP_PASSWORD set
    Then the CLI should detect the running server via health check
    And it should create a new tmux window with Claude Code
    And no password prompt should appear
    # [Screenshot: sync-A6-second-terminal.png]

  Scenario: codetap -a lists active sessions for current project (A7)
    Given I have 2 active sessions in the current project directory
    When I run `codetap -a`
    Then I should see a numbered list with format:
      | Field        | Example                                      |
      | Internal ID  | claude-1774210269126                         |
      | UUID         | 625c60d0-aedb-4e0b-b78e-c9fbf0405e67         |
      | Preview      | First line of tmux pane content               |
    When I select a session by number
    Then I should attach to that tmux window

  Scenario: codetap -A lists ALL active sessions across projects (A8)
    Given I have active sessions in different project directories
    When I run `codetap -A`
    Then I should see all active sessions regardless of project

  Scenario: codetap stop kills server and all sessions (A9)
    Given the server is running with 2 active sessions visible in the Active tab
    When I run `codetap stop` in a terminal
    Then the server should shut down
    And all sessions should disappear from the Active tab
    And mobile should show the offline/reconnecting state
    # [Screenshot: sync-A9-after-stop.png]

  Scenario: codetap --continue resumes most recent session (A10)
    Given I have a historical session from a recent conversation
    When I run `codetap --continue` in a terminal
    Then the most recent session should be resumed
    And the Active tab should show the resumed session
    # [Screenshot: sync-A10-continue.png]


Feature: CLI — codetap new
  Background:
    Given the CodeTap server is running

  Scenario: codetap new starts a Claude session (default adapter)
    When I run `codetap new` in a terminal
    Then a tmux window named "claude-{timestamp}" should be created
    And the Claude CLI should start with --dangerously-skip-permissions

  Scenario: codetap new --adapter codex starts a Codex session
    When I run `codetap new --adapter codex` in a terminal
    Then a tmux window named "codex-{timestamp}" should be created
    And the Codex CLI should start with -a never

  Scenario: codetap new without --adapter defaults to claude
    When I run `codetap new` without specifying --adapter
    Then the adapter should default to "claude"


Feature: CLI — codetap --resume
  Background:
    Given the CodeTap server is running
    And I have previous sessions from both Claude and Codex

  Scenario: codetap --resume with window name
    When I run `codetap --resume claude-1774225283`
    Then the Claude CLI should resume with --resume claude-1774225283

  Scenario: codetap --resume with Claude CLI UUID
    Given a Claude session with UUID "81dec4e4-739c-4f24-9b08-23952037fb0f" exists
    When I run `codetap --resume 81dec4e4-739c-4f24-9b08-23952037fb0f`
    Then the adapter should be auto-detected as "claude" from DB or JSONL scan
    And the Claude CLI should resume that session

  Scenario: codetap --resume with Codex CLI UUID
    Given a Codex session with UUID "019d17de-8a7f-72c3-b879-6fcd21dab303" exists
    When I run `codetap --resume 019d17de-8a7f-72c3-b879-6fcd21dab303`
    Then the adapter should be auto-detected as "codex" from DB or JSONL scan
    And the Codex CLI should resume that session

  Scenario: codetap --resume auto-detects adapter from DB
    Given a session with id "codex-1774225400" exists in the DB with adapter "codex"
    When I run `codetap --resume codex-1774225400` without --adapter
    Then the adapter should be detected as "codex" from the DB
    And the Codex CLI should resume that session

  Scenario: codetap --resume auto-detects adapter from JSONL file scan
    Given a Claude JSONL file exists at ~/.claude/projects/.../<uuid>.jsonl
    And the session is NOT in the CodeTap DB
    When I run `codetap --resume <uuid>`
    Then the adapter should be detected as "claude" from the JSONL file scan

  Scenario: codetap --adapter codex --resume skips search
    When I run `codetap --adapter codex --resume some-id`
    Then the search should be skipped
    And the Codex CLI should directly attempt to resume "some-id"

  Scenario: codetap --resume with unknown ID and no --adapter shows error
    When I run `codetap --resume nonexistent-id`
    Then an error should be shown: "Session not found: nonexistent-id"

  Scenario: codetap --resume with unknown ID + --adapter passes through
    When I run `codetap --adapter claude --resume nonexistent-id`
    Then the Claude CLI should attempt to resume "nonexistent-id"
    And the CLI itself will handle the error if the session doesn't exist


Feature: CLI — codetap --continue
  Background:
    Given the CodeTap server is running

  Scenario: codetap --continue resumes most recent Claude session
    When I run `codetap --continue`
    Then the Claude CLI should run with --continue flag

  Scenario: codetap --adapter codex --continue resumes most recent Codex session
    When I run `codetap --adapter codex --continue`
    Then the Codex CLI should run `codex -a never resume --last`

  Scenario: codetap --continue without --adapter defaults to claude
    When I run `codetap --continue` without specifying --adapter
    Then the adapter should default to "claude"


Feature: CLI — codetap hooks
  Background:
    Given the CodeTap server is running

  Scenario: codetap hooks install installs Claude + Codex hooks
    When I run `codetap hooks install`
    Then hooks should be installed in ~/.claude/settings.json
    And hooks should be installed in ~/.codex/hooks.json

  Scenario: codetap hooks uninstall removes Claude + Codex hooks
    When I run `codetap hooks uninstall`
    Then CodeTap hooks should be removed from ~/.claude/settings.json
    And CodeTap hooks should be removed from ~/.codex/hooks.json

  Scenario: hooks install enables codex_hooks feature flag
    When I run `codetap hooks install`
    Then ~/.codex/config.toml should contain codex_hooks = true under [features]


Feature: CLI — codetap -a / -A (session listing)
  Background:
    Given the CodeTap server is running
    And I have active Claude and Codex sessions in tmux

  Scenario: codetap -a lists only current project sessions
    When I run `codetap -a` in a project directory
    Then only sessions with cwd matching the current directory should be listed

  Scenario: codetap -A lists all sessions across all projects
    When I run `codetap -A`
    Then all active sessions from all projects should be listed

  Scenario: codetap -a shows adapter label with color
    When I run `codetap -a`
    Then Claude sessions should show an amber [Claude] label
    And Codex sessions should show a green [Codex] label

  Scenario: codetap -a shows both window name and CLI session UUID
    When I run `codetap -a`
    Then each session should display:
      | Field       | Example                                |
      | Adapter     | [Claude] or [Codex]                    |
      | Window      | claude-1774225283                      |
      | UUID        | 81dec4e4-739c-4f24-9b08-23952037fb0f   |
      | Preview     | (first line of pane content)           |

  Scenario: codetap -a with no active sessions shows helpful message
    Given no tmux windows exist (except main)
    When I run `codetap -a`
    Then I should see "No active sessions"

  Scenario: codetap -A shows cwd path for each session
    When I run `codetap -A`
    Then each session should additionally show its working directory path

  Scenario: codetap -a with tmux windows not in DB shows adapter as unknown
    Given a tmux window exists that was not created by CodeTap
    When I run `codetap -a`
    Then that session should show adapter as "?" with no UUID


Feature: Desktop ↔ Mobile — Session Lifecycle
  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: Desktop /exit ends session — becomes historical (LC1)
    # /exit terminates Claude CLI → tmux window closes → session removed from Active
    # BUT the session still exists as historical (JSONL file persists)
    Given I have an active session visible in the Active tab
    And mobile is connected to the session
    When the desktop user types "/exit" in Claude CLI
    # T0: Claude CLI exits → tmux window closes → SessionEnd hook fires
    Then mobile should receive a SESSION_ENDED event
    And the session should disappear from the Active tab
    # [Screenshot: lifecycle-LC1-session-ended.png]
    # T1: Session is now historical — still visible in Projects drill-down
    When I navigate to the project in the Projects tab
    Then the session should still appear in the sessions list (historical)
    And the green dot should NOT be shown (not active)
    # [Screenshot: lifecycle-LC1-historical.png]

  Scenario: Full session lifecycle — create → use → exit → resume (LC2)
    # Complete lifecycle test: active → historical → active again
    # T0: Create session from desktop
    When I start a desktop session via `codetap`
    And I type "Hello from lifecycle test" in the desktop terminal
    Then the Active tab should show the session
    # [Screenshot: lifecycle-LC2-T0-active.png]

    # T1: Exit session — becomes historical
    When the desktop user types "/exit" in Claude CLI
    Then the session should disappear from the Active tab
    # [Screenshot: lifecycle-LC2-T1-historical.png]

    # T2: Resume session — becomes active again
    When I run `codetap --resume <session-id>` in a new terminal
    Then the Active tab should show the resumed session
    And the previous messages should be visible when connecting from mobile
    # [Screenshot: lifecycle-LC2-T2-resumed.png]

  Scenario: Desktop detaches from tmux — session stays active (LC3)
    # User presses Ctrl+B, D to detach — Claude CLI keeps running in background
    Given I have an active session started via `codetap`
    And mobile is connected to the session
    When the desktop user detaches from tmux (Ctrl+B, D)
    Then the tmux window should still be running (Claude CLI alive)
    And the session should still appear in the Active tab
    And mobile should still be able to send messages
    And Claude should still respond (running headlessly in tmux)
    # [Screenshot: lifecycle-LC3-detached-still-active.png]

  Scenario: Desktop re-attaches to tmux after detach (LC4)
    Given a session is running in tmux (detached)
    When the desktop user runs `tmux attach -t codetap`
    Then they should see the Claude CLI exactly where they left off
    And the session should continue working normally

  Scenario: Mobile disconnect — session persists in tmux (LC5)
    Given I have an active session with mobile connected
    When I close the mobile browser tab
    Then the tmux window should still be running
    And the session should still appear in the Active tab (no clients)
    When I reopen the mobile app and connect to the session
    Then all previous messages should be preserved
    And I should be able to continue sending messages
    # [Screenshot: lifecycle-LC5-mobile-reconnect.png]

  Scenario: Server restart — sessions survive in tmux (LC6)
    Given I have 2 active sessions running in tmux
    When the server process is killed (simulating crash)
    Then the tmux windows should still be running (Claude CLI alive)
    When the server is restarted
    And I open the mobile app
    # Note: Sessions are recovered via SQLite. CLI UUID is the primary key.
    # When hooks fire from surviving CLI instances, sessions are found directly by UUID.
    When I connect to a known session ID from a previous page
    Then the session should re-attach and history should be preserved
    # [Screenshot: lifecycle-LC6-server-restart.png]

  Scenario: Non-graceful restart restores session by CLI UUID (LC7)
    Given a session exists with CLI UUID "d6d56787-bfaf-4312-ae4d-99683ba45459"
    When the server crashes without running shutdown
    And the tmux window survives
    And the server restarts
    When the CLI fires a hook (e.g., UserPromptSubmit)
    Then the session should be found directly by CLI UUID in the DB
    And the session should reappear in Active tab with the same CLI UUID

  Scenario: Disconnect button kills tmux window (LC8)
    Given I have an active session in the Active tab
    When I expand the session card and tap "Disconnect"
    Then the tmux window should be killed
    And the session should disappear from the Active tab
    And if mobile was connected, it should receive SESSION_ENDED
    # [Screenshot: lifecycle-LC7-disconnect-kill.png]


Feature: Desktop ↔ Mobile — Bidirectional Message Sync
  Background:
    Given I am logged in
    And I have a desktop session running in tmux
    And I am connected to that session from mobile

  Scenario: Mobile input syncs to desktop (B1)
    When I send "Hi" from mobile
    Then the desktop tmux pane should show "Hi" being typed
    And Claude's response should appear on both mobile and desktop
    # [Screenshot: sync-B1-mobile-to-desktop.png]

  Scenario: Desktop input syncs to mobile (B2)
    When I type "Tell me a joke" in the desktop terminal
    Then within 10 seconds mobile should show a user message bubble "Tell me a joke"
    And mobile should show the assistant response bubble
    # [Screenshot: sync-B2-desktop-to-mobile.png]

  Scenario: Alternating input from both sides (B3)
    # --- Timeline: Three-round alternating conversation ---
    # T0: Mobile sends first
    When I send "Round 1 from mobile" from mobile
    Then both sides should show the response
    # [Screenshot: sync-B3-T0-round1.png]

    # T1: Desktop sends second
    When I type "Round 2 from desktop" in the desktop terminal
    Then mobile should show both the user message and response
    # [Screenshot: sync-B3-T1-round2.png]

    # T2: Mobile sends third
    When I send "Round 3 from mobile" from mobile
    Then all 6 messages (3 user + 3 assistant) should be visible on both sides
    And the order should be consistent between mobile and desktop
    # [Screenshot: sync-B3-T2-round3.png]


Feature: Desktop ↔ Mobile — Resume Session Sync
  # These test the complete flow: desktop resumes an old session → mobile connects → both chat
  # Resume has unique mechanics: different JSONL path lookup, session mapping, history loading

  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: codetap CLI new session → mobile connect → bidirectional chat (RS1)
    # Full flow: desktop starts fresh session via CLI, mobile discovers and joins
    # T0: Desktop starts session
    When I run `codetap` in a terminal
    And I type "Hello from desktop" in the desktop terminal
    And Claude responds
    # [Screenshot: sync-RS1-T0-desktop-started.png]

    # T1: Mobile discovers and connects
    When I open the Active tab on mobile
    Then I should see the session with firstPrompt "Hello from desktop"
    When I expand and tap "Connect"
    Then I should see the full history: user "Hello from desktop" + assistant response
    # [Screenshot: sync-RS1-T1-mobile-connected.png]

    # T2: Mobile sends — desktop sees
    When I send "Hello from mobile" from mobile
    Then the desktop tmux pane should show "Hello from mobile" being typed
    And Claude's response should appear on both sides
    # [Screenshot: sync-RS1-T2-mobile-to-desktop.png]

    # T3: Desktop sends — mobile sees in real-time
    When I type "Desktop reply" in the desktop terminal
    Then mobile should show a user message "Desktop reply" (blue bubble)
    And mobile should show Claude's response
    # [Screenshot: sync-RS1-T3-desktop-to-mobile.png]

  Scenario: codetap --resume → mobile connect → bidirectional chat (RS2)
    # Resume an old session via CLI argument
    # NOTE: `codetap --resume` uses --dangerously-skip-permissions (YOLO mode) by default
    Given I have a historical session with known ID from a previous conversation
    # T0: Desktop resumes (YOLO mode)
    When I run `codetap --resume <session-id>` in a terminal
    Then the Claude CLI should load the old session's context
    And permission mode should be "YOLO" (bypassPermissions)
    # [Screenshot: sync-RS2-T0-resumed.png]

    # T1: Mobile discovers
    When I open the Active tab on mobile
    Then I should see the resumed session
    When I connect to it
    Then I should see the old conversation history plus any new messages
    # [Screenshot: sync-RS2-T1-mobile-history.png]

    # T2: Bidirectional chat in resumed session
    When I send "Continue from mobile" from mobile
    Then Claude should respond in context of the old conversation
    And the desktop should show the mobile-sent message and response
    # [Screenshot: sync-RS2-T2-resume-sync.png]

    When I type "Continue from desktop" in the desktop terminal
    Then mobile should show the desktop message and response in real-time
    # [Screenshot: sync-RS2-T3-resume-desktop.png]

  Scenario: Claude CLI /resume → mobile connect → bidirectional chat (RS3)
    # Resume via the /resume command inside an already-running Claude CLI
    Given I have an active Claude CLI session in tmux
    # T0: Desktop uses /resume
    When I type "/resume" in the Claude CLI
    And I select an old session from the list
    Then Claude should load the old session's context
    # [Screenshot: sync-RS3-T0-cli-resume.png]

    # T1: Mobile discovers the resumed session
    When I check the Active tab on mobile
    Then the old session should appear as active
    When I connect to it
    Then the old conversation history should be visible
    # [Screenshot: sync-RS3-T1-mobile-connected.png]

    # T2: Chat continues with sync
    When I send "Question about previous context" from mobile
    Then Claude should answer using context from the old session
    And desktop should show the mobile message
    # [Screenshot: sync-RS3-T2-resume-chat.png]

  Scenario: Mobile resumes historical session → desktop window created → sync (RS4)
    # User browses old sessions on mobile and reopens one
    Given I have a historical session in the Projects tab (not currently active)
    # T0: Mobile opens old session
    When I navigate to the project and tap on a historical session
    Then the chat view should load with full history
    # [Screenshot: sync-RS4-T0-history-loaded.png]

    # T1: Mobile sends a new message (triggers session resume)
    When I send "Continuing this old session from mobile"
    Then a new tmux window should be created in the codetap session
    And Claude should respond in context of the old conversation
    # [Screenshot: sync-RS4-T1-session-resumed.png]

    # T2: Desktop can see and interact with the resumed session
    When the desktop user attaches to the tmux window
    Then they should see Claude's prompt ready for input
    When the desktop user types "Desktop also joining"
    Then mobile should show the desktop message in real-time
    # [Screenshot: sync-RS4-T2-desktop-joins.png]

  Scenario: Long response streaming sync (B4)
    When I send a complex question from mobile
    # T0: Thinking
    Then mobile should show the thinking indicator
    # [Screenshot: sync-B4-T0-thinking.png]

    # T1: Streaming preview
    Then the streaming preview should appear with partial response text
    # [Screenshot: sync-B4-T1-streaming.png]

    # T2: Complete
    Then the full response should appear as a single bubble (no duplicate)
    And the streaming indicator should disappear
    # [Screenshot: sync-B4-T2-complete.png]

  Scenario: Tool call response syncs correctly (B5)
    When I send "Read the file package.json" from mobile
    Then mobile should show a tool card for "Read" with running status
    And within 15 seconds the tool should complete (green checkmark)
    And the assistant response should appear on mobile
    And the desktop terminal should show the same tool execution
    # [Screenshot: sync-B5-tool-sync.png]


Feature: Response Display Correctness
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Single response — no duplicate bubble (C1)
    When I send a simple question from mobile
    Then I should see exactly one response bubble
    And there should NOT be a simultaneous "Responding..." bubble
    And there should NOT be two copies of the same response text
    # [Screenshot: response-C1-no-duplicate.png]

  Scenario: Multi-tool turn — single final response (C2)
    When I send a request that triggers multiple tool calls
    Then tool cards should appear and transition (running → success)
    And the final assistant response should appear as exactly one bubble
    And there should be no duplicate or ghost bubbles
    # [Screenshot: response-C2-multi-tool.png]

  Scenario: Thinking indicator lifecycle (C3)
    When I send a question that requires thinking
    # T0: Thinking shows
    Then the thinking indicator should appear (spinner + verb)
    # [Screenshot: response-C3-T0-thinking.png]

    # T1: Response replaces thinking
    Then when the response appears, the thinking indicator should disappear
    And only the response bubble should remain
    # [Screenshot: response-C3-T1-response.png]

  Scenario: Interrupt then re-send (C4)
    When I send a question from mobile
    And I tap the stop button during streaming
    Then the response should be marked as interrupted
    # [Screenshot: response-C4-interrupted.png]

    When I send a follow-up message
    Then the new response should display normally
    And the interrupted marker should remain in history
    # [Screenshot: response-C4-followup.png]


Feature: Active Sessions — Expandable Cards & Disconnect
  Background:
    Given I am logged in
    And I have active sessions running

  Scenario: Active session shows firstPrompt instead of UUID (A1/5a)
    Given a desktop session has been used with the first message "Explain React hooks"
    When I view the Active tab
    Then the session should display "Explain React hooks" as the title
    And it should NOT show a raw UUID like "f925ca56-6093-4ebd-..."
    # [Screenshot: active-firstprompt.png]

  Scenario: Expand active session card
    When I tap on an active session row
    Then the card should expand to show additional details
    And I should see a "Connect" button
    And I should see a "Disconnect" button (in red)
    # [Screenshot: active-expanded-card.png]

  Scenario: Expanded active session card shows session ID
    When I expand an active session card
    Then I should see the CLI UUID (e.g. "d6d56787-bfaf-4312...")
    And a copy button should be available for the UUID
    And the card title remains the firstPrompt (not UUID)

  Scenario: Collapse expanded card
    Given an active session card is expanded
    When I tap on the same session row again
    Then the card should collapse back to the compact view

  Scenario: Connect to active session
    Given an active session card is expanded
    When I tap "Connect"
    Then I should enter the chat view for that session
    And the full message history should load
    # [Screenshot: active-connect.png]

  Scenario: Disconnect (destroy) active session
    Given an active session card is expanded
    When I tap "Disconnect"
    Then the session should be removed from the Active list
    And the tmux window should be killed
    And the Active count should decrease by 1
    # [Screenshot: active-disconnect.png]

  Scenario: Active tab refreshes every 3 seconds
    Given I am viewing the Active tab
    When a new session becomes active
    Then it should appear in the Active tab within 3 seconds
    # Previously: polling was 10 seconds, causing delayed discovery


Feature: Reconnect — Streaming State Restoration
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Refresh during idle — no streaming indicator (E1)
    Given Claude is idle (waiting for input)
    When I refresh the page
    Then I should see the full message history
    And there should be NO streaming indicator or thinking status
    # [Screenshot: reconnect-E1-idle.png]

  Scenario: Refresh during thinking — indicator restored (E1b)
    When I send a question from mobile
    And Claude is currently thinking (spinner visible)
    When I refresh the page
    Then I should see the message history
    And the thinking/streaming indicator should reappear within 1 second
    # [Screenshot: reconnect-E1b-thinking-restored.png]

  Scenario: Refresh during response — streaming restored (E1c)
    When I send a question from mobile
    And Claude is currently streaming a response
    When I refresh the page
    Then I should see the message history
    And the streaming indicator should reappear
    And when the response completes, the indicator should disappear normally
    # [Screenshot: reconnect-E1c-streaming-restored.png]

  Scenario: Refresh during desktop-sent thinking — indicator restored (E1d)
    # E1b/E1c only test mobile-sent. This covers desktop-sent.
    Given I have a desktop session with mobile connected
    When the desktop user sends a complex message
    And mobile shows the "Working..." indicator
    When I refresh the mobile browser
    Then I should see the message history
    And the "Working..." indicator should reappear within 1 second
    And when the response completes, the indicator should disappear normally
    # Mechanism: handleReconnect sends SESSION_STATE streaming:true when isProcessing
    # [Screenshot: reconnect-E1d-desktop-thinking-restored.png]

  Scenario: Refresh during tool execution — tool card restored (E1e)
    # Tool statuses are replayed via TOOL_UPDATES on reconnect.
    Given a desktop session has a tool in progress (e.g. Read)
    And mobile shows the tool card with a spinner
    When I refresh the mobile browser
    Then I should see the message history
    And the tool card should reappear with running status
    # Mechanism: handleReconnect sends TOOL_UPDATES with parser.getPendingTools()
    # [Screenshot: reconnect-E1e-tool-restored.png]

  Scenario: Refresh during permission request — overlay restored (E1f)
    Given a desktop session has a pending permission request (e.g. Write tool)
    And mobile shows the permission overlay
    When I refresh the mobile browser
    Then I should see the message history
    And the permission overlay should reappear with the same tool name and input
    # Mechanism: handleReconnect sends PERMISSION_REQUEST from pendingPermissions
    # [Screenshot: reconnect-E1f-permission-restored.png]

  Scenario: Refresh during AskUserQuestion — options restored (E1g)
    Given a desktop session has a pending AskUserQuestion
    And mobile shows the question options UI
    When I refresh the mobile browser
    Then I should see the message history
    And the question options should reappear
    # Mechanism: handleReconnect sends PERMISSION_REQUEST from pendingQuestions
    # [Screenshot: reconnect-E1g-question-restored.png]

  Scenario: Refresh during compacting context — status restored (E1h)
    Given a session is compacting context ("Compacting context..." visible)
    When I refresh the mobile browser
    Then I should see the message history
    # NOTE: Compacting is driven by PreCompact hook → thinkingStatus state.
    # On reconnect, thinkingStatus is not persisted — PaneMonitor must re-detect.
    # The "Compacting context..." text may not reappear immediately.
    # [Screenshot: reconnect-E1h-compacting.png]

  Scenario: Refresh with queued message pending (E1i)
    # Queued messages are stored in client-side React state (queuedRef).
    # They are NOT persisted server-side and will be lost on refresh.
    Given I have an active session with Claude processing
    And I type a second message (queued, not yet sent)
    When I refresh the mobile browser
    Then the queued message should be gone (client-only state)
    And the input field should be empty
    # [Screenshot: reconnect-E1i-queued.png]

  Scenario: Refresh after user pressed stop — interrupted state (E1j)
    Given Claude was processing and I pressed the stop button
    And the chat shows an interrupt marker
    When I refresh the mobile browser
    Then I should see the full message history including the interrupt marker
    And there should be no streaming indicator
    # [Screenshot: reconnect-E1j-interrupted.png]

  Scenario: Refresh during Agent tool with sub-tools running (E1k)
    Given a desktop session has an Agent tool running with sub-tools in progress
    And mobile shows the Agent card with sub-tool spinners
    When I refresh the mobile browser
    Then I should see the message history
    And the Agent tool card should reappear with running sub-tools
    # Mechanism: handleReconnect sends TOOL_UPDATES with pending tools
    # [Screenshot: reconnect-E1k-agent-subtools.png]

  Scenario: Refresh during desktop-sent streaming preview (E1l)
    # E1c only tests mobile-sent. This covers desktop-sent.
    Given I have a desktop session with mobile connected
    When the desktop user sends a long message
    And mobile shows streaming text preview (partial response)
    When I refresh the mobile browser
    Then I should see the message history
    And the streaming indicator should reappear
    And streaming text preview should resume via PaneMonitor
    # [Screenshot: reconnect-E1l-desktop-streaming.png]

  Scenario: Connect to processing session from Active tab (G7)
    Given a desktop session is currently processing a response
    When I tap on that session in the Active tab
    Then I should see the message history
    And the streaming/thinking indicator should be visible
    And when the response completes, it should appear normally
    # [Screenshot: reconnect-G7-connect-processing.png]

  Scenario: Session ended — Active tab updates, history preserved (E4)
    Given I have an active session visible in the Active tab
    When the Claude CLI session terminates (desktop user types /exit)
    Then the session should disappear from the Active tab on next refresh
    # Note: session is still historical — visible in Projects drill-down, can /resume
    When I navigate to the project in the Projects tab
    Then the session should still appear in the sessions list (with messages)
    # [Screenshot: reconnect-E4-session-ended.png]


Feature: Desktop ↔ Mobile — Permission & Mode Sync
  Background:
    Given I am logged in
    And I have a desktop session connected from mobile
    And permission mode is "Normal"

  Scenario: Permission overlay appears on both sides simultaneously (D1)
    When Claude tries to execute a tool requiring permission (e.g. Write file)
    Then the desktop terminal should show its own permission prompt
    And the mobile should show the permission overlay
    And either side can answer — first response wins
    # [Screenshot: sync-D1-both-sides-permission.png]

  Scenario: Desktop answers permission — mobile overlay dismisses on turn complete (D2)
    Given both desktop and mobile show a permission prompt
    When the desktop user answers "Yes" in the terminal
    Then the tool should proceed on desktop
    # Note: mobile overlay does NOT dismiss immediately when desktop answers.
    # It dismisses when TURN_COMPLETE fires (after tool execution finishes),
    # because setPermissionRequest(null) is in the TURN_COMPLETE handler.
    Then when the turn completes, the mobile overlay should auto-dismiss

  Scenario: Mobile answers permission — desktop prompt resolves (D3)
    Given both desktop and mobile show a permission prompt
    When I tap "Allow" on the mobile overlay
    Then the overlay should dismiss
    And the desktop terminal should show the tool proceeding

  Scenario: Desktop Shift+Tab changes mode — mobile reflects (D5)
    Given mobile StatusBar shows "Normal"
    When the desktop user presses Shift+Tab to switch to "YOLO"
    Then within 2 seconds the mobile StatusBar should update to "YOLO"
    # [Screenshot: sync-D5-desktop-mode-change.png]

  Scenario: Mobile mode change — desktop reflects (D6)
    Given mobile StatusBar shows "Normal"
    When I tap the permission mode label on mobile to switch to "Auto-edit"
    Then the desktop terminal should show "accept edits on" indicator
    # [Screenshot: sync-D6-mobile-mode-change.png]

  Scenario: AskUserQuestion from desktop shows on mobile (D4)
    When Claude uses the AskUserQuestion tool from desktop
    Then mobile should display the ask-question overlay (not permission overlay)
    And it should show the question text and selectable options
    # [Screenshot: sync-D4-ask-question.png]

    When I select an option on mobile
    Then the answer should be sent to the desktop terminal
    And Claude should continue processing
    # [Screenshot: sync-D4-answered.png]

  Scenario: Desktop Ctrl+C interrupt — mobile sees interrupt (D7)
    Given mobile is connected and Claude is streaming a response
    When the desktop user presses Ctrl+C in the terminal
    Then the streaming should stop on desktop
    And mobile should show the interrupt marker "⎿ Interrupted..."
    And the streaming indicator should disappear on mobile
    # [Screenshot: sync-D7-desktop-interrupt.png]


Feature: Edge Cases
  Background:
    Given I am logged in

  Scenario: Empty session in Active tab (G1)
    Given a desktop session was just started but no message sent
    When I view the Active tab
    Then the session should appear with the session UUID as fallback title
    # [Screenshot: edge-G1-empty-session.png]

  Scenario: Long streaming preview truncated (G2)
    When I send a question that triggers a very long response
    Then the streaming preview should truncate at ~200 characters
    And the full response should display completely when done
    # [Screenshot: edge-G2-long-preview.png]

  Scenario: Compacting context indicator (G3)
    Given I have a long conversation approaching context limits
    When Claude compacts the conversation context
    Then mobile should show "Compacting context..." as the thinking status
    And when compacting finishes, the indicator should be replaced by normal status
    # [Screenshot: edge-G3-compacting.png]

  Scenario: Queued message auto-sends after response (G6)
    When I send a message and Claude starts responding
    And I type a second message and tap send while streaming
    # T0: Message queued
    Then a queued message bubble should appear with "Queued" badge
    # [Screenshot: edge-G6-T0-queued.png]

    # T1: First response completes → queued auto-sends
    Then when the first response finishes, the queued message should auto-send
    And it should appear as a regular user message bubble
    # [Screenshot: edge-G6-T1-auto-sent.png]


# =============================================================================
# REGRESSION TESTS
# =============================================================================

# =============================================================================
# BUG REGRESSION: Session Deduplication
# =============================================================================
# Regression tests for: desktop + mobile connecting to same session should
# produce exactly ONE entry in Active tab, not two.

Feature: Regression — Session Deduplication
  Background:
    Given I am logged in
    And the server is running with tmux

  # Regression (DEDUP-1): Previously, dual ID system (internal ID vs CLI UUID)
  # caused confusion where Connect button passed the wrong ID type.
  # Fix: Unified to single CLI UUID — no dual-ID confusion possible.

  Scenario: Desktop session + mobile connect → single Active entry (DEDUP-1)
    When I start a desktop session via `codetap`
    And I type "Say hello in one word" in the desktop terminal
    And Claude responds
    Then the Active tab should show exactly 1 session with firstPrompt "Say hello in one word"
    # [Screenshot: dedup-1-single-before-connect.png]

    # Mobile connect — should attach to the SAME session, not create a second one
    When I tap on the session and tap "Connect"
    Then I should enter the chat view with full history
    When I go back to the Active tab
    Then the Active tab should still show exactly 1 session (not 2)
    And it should show "1 connected" (the mobile WebSocket client)
    # [Screenshot: dedup-1-single-after-connect.png]

    # Reconnect after refresh — should still be 1 session
    When I refresh the mobile browser and reconnect
    Then the Active tab should still show exactly 1 session
    # [Screenshot: dedup-1-after-reconnect.png]


# =============================================================================
# Regression — SessionStart Hook API POST
# =============================================================================

Feature: Regression — SessionStart Hook API POST

  # SessionStart hook must fire POST to /api/hooks/{adapter}/session-start
  # (not write to session-map.json). This enables real-time session discovery.

  Scenario: codetap new session appears in Active tab immediately
    Given the server is running
    When I run `codetap new` in a terminal
    And the Claude CLI starts and fires SessionStart hook
    Then the session should appear in the Active tab within 5 seconds
    And no session-map.json file should be created


# =============================================================================
# BUG REGRESSION: Desktop → Mobile Streaming Indicator
# =============================================================================
# Regression tests for: when desktop sends a message, mobile should immediately
# show a "Working..." / thinking indicator instead of waiting 500ms+ for
# PaneMonitor to detect streaming.

Feature: Regression — Desktop Message Streaming Indicator
  Background:
    Given I am logged in
    And I have a desktop session connected from mobile

  Scenario: Desktop sends message → mobile shows immediate indicator (STREAM-1)
    # Regression (Bug 1): processing-started event was not forwarded by ClaudeAdapter
    # → SESSION_STATE streaming:true never broadcast → TOOL_START/THINKING/TEXT_DELTA gated out.
    # Regression (Bug 2): ChatView condition checked last message role instead of
    # pendingResponse flag → even with SESSION_STATE, indicator failed for desktop-sent.
    When the desktop user types "Explain React hooks" in the terminal
    # T0: Immediate — "Working..." indicator via SESSION_STATE (not waiting for PaneMonitor)
    Then mobile should show the "Working..." indicator within 500ms
    # [Screenshot: stream-1-T0-immediate-indicator.png]

    # T1: User message arrives via JSONL watcher (may take 1-2s)
    Then mobile should display the user message "Explain React hooks" (blue bubble)
    # [Screenshot: stream-1-T1-user-message.png]

    # T2: Thinking — PaneMonitor detects thinking state
    Then the indicator should transition to thinking text (e.g. "Analyzing...")
    # [Screenshot: stream-1-T2-thinking.png]

    # T3: Tool use — if Claude uses tools, TOOL_START events are no longer gated out
    Then tool cards should appear with running indicators
    And each tool should transition to completed (green checkmark) when done
    # [Screenshot: stream-1-T3-tools.png]

    # T4: Response complete
    Then the response should appear as a single bubble
    And the streaming indicator should disappear
    # [Screenshot: stream-1-T4-complete.png]

  Scenario: Desktop rapid messages → mobile indicators cycle correctly (STREAM-2)
    When the desktop user types "First question" and Claude responds
    Then mobile should show indicator → response → idle
    When the desktop user types "Second question"
    Then mobile should show the indicator again immediately
    And previous turn's tool cards should retain their completed (✓) status
    # Note: tool statuses are NOT cleared between turns — IDs are unique, old entries don't interfere
    # [Screenshot: stream-2-rapid-turns.png]

  Scenario: Desktop sends while mobile shows no indicator → tool events not lost (STREAM-3)
    # Regression: TOOL_START was gated on streamingRef.current — dropped when false.
    When the desktop user types "Read package.json" in the terminal
    Then mobile should show the "Working..." indicator
    And a "Read" tool card should appear with running status
    And the tool card should transition to completed (not stuck on running)
    # [Screenshot: stream-3-tool-not-lost.png]


# =============================================================================
# BUG REGRESSION: Tool Card Expanded View
# =============================================================================
# Regression tests for: expanding a tool card should show friendly per-tool
# display (file path, command, pattern) instead of raw JSON dump.

Feature: Regression — Tool Card Display
  Background:
    Given I am logged in
    And I have an active chat session with completed tool calls

  Scenario: Read tool card shows file path, not JSON (TOOLUI-1)
    Given Claude has completed a Read tool call for "package.json"
    When I tap on the Read tool card to expand it
    Then I should see the file path "package.json" as a header
    And I should see the file contents as formatted code
    And I should NOT see raw JSON like {"file_path": "package.json", "limit": ...}
    # [Screenshot: toolui-1-read-expanded.png]

  Scenario: Bash tool card shows command and output (TOOLUI-2)
    Given Claude has completed a Bash tool call with command "ls -la"
    When I tap on the Bash tool card to expand it
    Then I should see "$ ls -la" styled as a terminal command
    And I should see the command output below
    And I should NOT see raw JSON like {"command": "ls -la", "description": ...}
    # [Screenshot: toolui-2-bash-expanded.png]

  Scenario: Grep tool card shows pattern and results (TOOLUI-3)
    Given Claude has completed a Grep tool call with pattern "TODO"
    When I tap on the Grep tool card to expand it
    Then I should see "Pattern: TODO" as the header
    And I should see matching file paths or content lines
    # [Screenshot: toolui-3-grep-expanded.png]

  Scenario: Edit tool card still shows diff view (TOOLUI-4)
    # Existing behavior — should NOT regress
    Given Claude has completed an Edit tool call
    When I tap on the Edit tool card to expand it
    Then I should see a diff view with red (removed) and green (added) lines
    And a "View full diff" link should be available
    # [Screenshot: toolui-4-edit-diff.png]

  Scenario: Agent tool card shows description, not raw JSON (TOOLUI-5)
    Given Claude has used an Agent tool with description "Explore code-tap codebase"
    When I tap on the Agent tool card to expand it
    Then I should see "Explore code-tap codebase" as the description
    And I should NOT see raw JSON like {"subagent_type": "Explore", "prompt": ...}
    # [Screenshot: toolui-5-agent-expanded.png]


# =============================================================================
# BUG REGRESSION: Agent Sub-Tool Display
# =============================================================================
# Regression tests for: Agent/Task tool cards should show their internal
# sub-tool calls (Read, Write, Bash, etc.) with running/completed status.

Feature: Regression — Agent Sub-Tool Display
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Agent tool shows nested sub-tools (SUBTOOL-1)
    # Regression: TranscriptParser ignored agent_progress entries from JSONL,
    # so SubagentGroup was never triggered.
    When I send a message that triggers an Agent tool (e.g. "search the codebase for X")
    # T0: Agent card appears with running spinner
    Then an Agent tool card should appear with a loading spinner
    And it should show the agent description (e.g. "Explore code-tap codebase")
    # [Screenshot: subtool-1-T0-agent-running.png]

    # T1: Sub-tools appear as Agent works
    Then sub-tool indicators should appear nested under the Agent card
    And each sub-tool should show its tool name (Read, Grep, Bash, etc.)
    And each should show its own status (running spinner or completed checkmark)
    # [Screenshot: subtool-1-T1-sub-tools-running.png]

    # T2: Agent completes
    Then the Agent card should show a completed status
    And all sub-tools should show completed status
    And a count badge should show (e.g. "5 tools completed")
    # [Screenshot: subtool-1-T2-agent-complete.png]

  Scenario: Expand Agent card to see sub-tool details (SUBTOOL-2)
    Given Claude has completed an Agent tool with sub-tools
    When I tap on the Agent card header
    Then it should expand to show all sub-tool cards
    And each sub-tool card should be expandable for details
    When I tap on a sub-tool "Read" card
    Then I should see the file path (not raw JSON)
    # [Screenshot: subtool-2-expanded-sub-tools.png]

  Scenario: Multiple parallel Agents each show their own sub-tools (SUBTOOL-3)
    When I send a message that triggers 2 parallel Agent tools
    Then 2 separate Agent cards should appear
    And each should show its own sub-tools independently
    And sub-tools should NOT be mixed between Agent cards
    # [Screenshot: subtool-3-parallel-agents.png]

  Scenario: Agent sub-tools in history load (SUBTOOL-4)
    Given I have a completed session that used Agent tools
    When I reconnect to that session from mobile
    Then the Agent tool cards should show the sub-tools from history
    And each sub-tool should show completed status
    And each sub-tool should display its tool name badge (Read, Bash, Glob, etc.)
    # [Screenshot: subtool-4-history-load.png]


# =============================================================================
# BUG REGRESSION: Agent Sub-Tool Badge & Label
# =============================================================================
# Regression tests for: sub-tool cards should show tool name badges (Read, Bash,
# Glob) and the SubagentGroup count label should say "tools" not "agents".

Feature: Regression — Agent Sub-Tool Badge & Label
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: Sub-tool cards show tool name badges (BADGE-1)
    # Regression: TOOL_UPDATES stored raw server objects with 'name' field,
    # but frontend expected 'toolName' → badge rendered empty.
    When I send a message that triggers an Agent tool with sub-tools
    Then each sub-tool card should display a tool name badge (Read, Bash, Glob, etc.)
    And the badge should NOT be empty or show a dash
    # [Screenshot: badge-1-tool-names.png]

  Scenario: SubagentGroup label says "tools" not "agents" (BADGE-2)
    # Regression: SubagentGroup hardcoded "agents" label for sub-tool count.
    When I view an Agent tool card with completed sub-tools
    Then the count label should say "N tools completed" (not "N agents completed")
    And while running, it should say "N/M tools" (not "N of M agents running...")
    # [Screenshot: badge-2-tools-label.png]


# =============================================================================
# BUG REGRESSION: /resume Session Streaming Indicator
# =============================================================================
# Regression tests for: when desktop uses /resume inside CLI to switch sessions,
# subsequent hooks should still resolve to the managed session.

Feature: Regression — /resume Session Streaming
  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: Desktop /resume then sends message → mobile sees indicator (RESUME-1)
    # Regression: /resume inside CLI changes session_id internally, but
    # resolveSessionId couldn't find the new ID → hooks silently dropped →
    # no processing-started emitted → mobile never saw streaming indicator.
    Given I have a desktop session started via `codetap`
    And mobile is connected to the session
    When the desktop user types "/resume" in Claude CLI and selects an old session
    And the desktop user types a new message in the resumed session
    Then mobile should show the "Working..." indicator within 1 second
    And the response should appear on mobile when complete
    # [Screenshot: resume-1-indicator.png]

  Scenario: /resume session hooks resolve correctly (RESUME-2)
    Given I have a desktop session with CLI UUID X
    When Claude CLI internally switches to session_id Y (via /resume)
    And a UserPromptSubmit hook fires with session_id Y
    Then the session should be found by CLI UUID Y in the sessions Map
    And the hook should NOT be silently dropped
    # Verified via: mobile receives SESSION_STATE streaming=true


# =============================================================================
# BUG REGRESSION: Desktop Client Visibility
# =============================================================================
# Regression tests for: Active tab should show desktop activity indicator
# separately from mobile WebSocket client count.

Feature: Regression — Desktop Client Visibility
  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: Active tab shows desktop indicator when hooks are active (CLIENT-1)
    # Regression: "connected" count only showed WebSocket clients. Desktop CLI
    # uses HTTP hooks, not WebSocket, so it was never counted.
    When I start a desktop session via `codetap` and send a message
    Then the Active tab should show "desktop" indicator for that session
    And if no mobile is connected, it should NOT show "0 connected"
    # [Screenshot: client-1-desktop-only.png]

  Scenario: Active tab shows both desktop and mobile (CLIENT-2)
    Given I have a desktop session with recent hook activity
    And mobile is connected via WebSocket
    Then the Active tab should show "desktop · 1 connected"
    # [Screenshot: client-2-desktop-and-mobile.png]


# =============================================================================
# BUG REGRESSION: Message Deduplication
# =============================================================================
# Regression tests for: messages should never appear twice on mobile.
# Root cause: JSONL watcher position was stale after HISTORY_LOAD, causing
# entries already in history to be re-emitted as "new" via MESSAGE_COMPLETE.

Feature: Regression — Message Deduplication
  Background:
    Given I am logged in
    And the server is running with tmux

  Scenario: Desktop message appears once after mobile reconnect (MSGDEDUP-1)
    # Regression: After mobile reconnect, HISTORY_LOAD sent all entries, but
    # the watcher's lastByteOffset was from before reconnect → watcher re-emitted
    # entries already in history → MESSAGE_COMPLETE appended duplicates.
    Given I have a desktop session with some conversation history
    And mobile connects and receives history via HISTORY_LOAD
    When the desktop user sends a new message
    Then the user message should appear exactly ONCE on mobile (blue bubble)
    And the assistant response should appear exactly ONCE
    And there should be NO duplicate bubbles of the same content
    # [Screenshot: msgdedup-1-no-duplicates.png]

  Scenario: Messages remain single after mobile browser refresh (MSGDEDUP-2)
    Given I have a desktop session with mobile connected
    And the conversation has 3+ exchanges
    When I refresh the mobile browser
    And mobile reconnects and loads history
    And the desktop user sends another message
    Then all messages should appear exactly once
    And the new message and response should each appear exactly once
    # [Screenshot: msgdedup-2-after-refresh.png]


# =============================================================================
# REGRESSION — Bug Fix Guards
# =============================================================================
# Each scenario guards against a specific user-visible bug that was previously fixed.
# Format: What the user should see (correct behavior), with comment about what
# previously went wrong.

Feature: Regression — Bug Fix Guards

  Scenario: Deny permission actually rejects the tool (REG-DENY-1)
    Given a permission overlay is showing for a Write tool
    When I tap "Deny"
    Then the tool should NOT execute
    And Claude should acknowledge the denial
    # Previously: Deny sent wrong key to CLI, tool executed anyway

  Scenario: HTTPS mode — tools and streaming work end-to-end (REG-HTTPS-1)
    Given the server is running in HTTPS mode
    And Claude is in Normal permission mode
    When I send a message that triggers a Write tool
    Then the permission overlay should appear
    When I tap Allow
    Then the tool should execute and complete
    And the response should stream to mobile normally
    And TURN_COMPLETE should fire (turn ends cleanly)
    # Previously: hooks used http:// but server ran HTTPS → all hooks silently failed,
    # TURN_COMPLETE never sent, streaming broken

  Scenario: Permission Allow sends correct key — tool executes (REG-PERM-1)
    Given a permission overlay is showing
    When I tap "Allow"
    Then the tool should execute within 5 seconds
    And the tool card should transition from Loading to Complete
    # Previously: CLI received wrong key sequence (Down+Enter instead of number key),
    # selected wrong option or typed into wrong prompt

  Scenario: No phantom Enter after permission response (REG-PERM-2)
    Given a permission overlay is showing
    When I tap "Allow" and the tool completes
    And Claude asks another question or shows another permission prompt
    Then the new prompt should NOT be auto-answered
    And the new prompt should wait for user input normally
    # Previously: extra Enter keystroke leaked into the next CLI prompt

  Scenario: Agent subtools finish — streaming continues (REG-SUBAGENT-1)
    Given Claude is running an Agent with subtools
    When the Agent's subtools complete
    Then the response text should continue streaming to mobile
    And tool cards should NOT be discarded
    And subsequent tool events should display normally
    # Previously: SubagentStop shared the Stop endpoint → killed streaming monitor,
    # sent premature TURN_COMPLETE, set streaming=false → tool events discarded

  Scenario: WS stays alive during long operations (REG-WS-1)
    Given mobile is connected during a 60-second thinking period
    Then the WS connection should remain open
    And the thinking indicator should stay visible throughout
    # Previously: no ping/pong → WS disconnected after ~30s idle

  Scenario: Streaming works after server restart (REG-MONITOR-1)
    Given the server was restarted but tmux sessions still exist
    When I connect to an existing session from mobile
    And the desktop user sends a message
    Then streaming text should appear on mobile incrementally
    And the response should NOT appear all at once when the turn ends
    # Previously: PaneMonitor never started for reconnected sessions,
    # response text appeared only after turn complete (no real-time streaming)

  Scenario: Permission overlay appears despite desktop mode change (REG-MODE-1)
    Given the desktop user changed from YOLO to Normal mode via Shift+Tab
    When Claude requests permission for a tool
    Then the permission overlay should appear on mobile
    # Previously: server cached stale YOLO mode, filtered out PermissionRequest

  Scenario: ExitPlanMode shows plan card, not permission overlay (REG-PLAN-1)
    Given the session is in Normal permission mode
    When Claude exits plan mode with a plan document
    Then a plan card with Approve/Reject/YOLO buttons should appear
    And NO generic permission overlay (Allow/Deny) should appear
    # Previously: ExitPlanMode fired PermissionRequest hook → showed wrong overlay

  Scenario: Permission overlay dismissed on all connected clients (REG-DISMISS-1)
    Given Mobile A and Mobile B are connected to the same session
    And both show a permission overlay
    When Mobile A taps "Allow"
    Then Mobile A's overlay should dismiss immediately
    And Mobile B's overlay should dismiss within 1 second
    # Previously: only answering client's overlay dismissed, other clients stuck

  Scenario: Send button enables after programmatic text input (REG-INPUT-1)
    Given I am in an empty chat
    When text is inserted into the input field programmatically (e.g., paste or autofill)
    Then the send button should become enabled
    # Previously: send button state only tracked React onChange, not DOM input events

  Scenario: Messages appear exactly once after reconnect (REG-DEDUP-1)
    Given a desktop session has some conversation history
    And mobile connects and loads history
    When the desktop user sends a new message
    Then the user message should appear exactly ONCE on mobile
    And the assistant response should appear exactly ONCE
    And there should be NO duplicate bubbles
    # Previously: JSONL watcher offset was stale after HISTORY_LOAD → re-emitted
    # entries already in history as new MESSAGE_COMPLETE events


# =============================================================================
# MULTI-CLIENT SYNC
# =============================================================================

Feature: Multi-Client — Mobile-to-Mobile Message Sync
  Background:
    Given I am logged in
    And I have a desktop session with tmux

  Scenario: Mobile A message visible on Mobile B (MULTI-1)
    # Regression: fromMobile flag caused ALL mobile clients to skip
    # the user message, not just the sender.
    Given Mobile A and Mobile B are both connected to the same session
    When Mobile A sends "Hello from A"
    Then Mobile A should show "Hello from A" (blue bubble, optimistic)
    And Mobile B should show "Hello from A" (blue bubble, from JSONL)
    And both should show the assistant response
    # [Screenshot: multi-1-cross-mobile-sync.png]

  Scenario: Mobile B message visible on Mobile A (MULTI-2)
    Given Mobile A and Mobile B are both connected to the same session
    When Mobile B sends "Hello from B"
    Then Mobile B should show "Hello from B" (optimistic)
    And Mobile A should show "Hello from B" (from JSONL)
    # [Screenshot: multi-2-reverse-sync.png]

  Scenario: Desktop message visible on all mobile tabs (MULTI-3)
    Given Mobile A and Mobile B are both connected to the same session
    When the desktop user sends "Hello from desktop"
    Then Mobile A and Mobile B should both show the user message and response
    # [Screenshot: multi-3-desktop-to-all.png]

  Scenario: No duplicate messages on sender (MULTI-4)
    # The sender gets the message optimistically + via JSONL.
    # senderClientId check prevents duplicates.
    Given Mobile A is connected to a session
    When Mobile A sends "Test dedup"
    Then "Test dedup" should appear exactly ONCE on Mobile A (not twice)
    # [Screenshot: multi-4-sender-no-dup.png]

Feature: Multi-Client — Active Session Client Count
  Background:
    Given I am logged in

  Scenario: Client count includes desktop and mobile tabs (COUNT-1)
    Given a desktop session is active (hooks firing)
    And 2 mobile tabs are connected to that session
    Then the Active tab should show "desktop · 2 connected"
    # [Screenshot: count-1-desktop-plus-2.png]

  Scenario: Client count updates when tab closes (COUNT-2)
    Given 2 mobile tabs are connected to a session
    When one tab is closed
    Then within 3 seconds, the Active tab should show "1 connected"
    # [Screenshot: count-2-tab-close.png]

  Scenario: Opening session tab counts as connected (COUNT-3)
    Given a session exists in the Active tab showing "desktop"
    When I tap Connect on that session (opening chat view)
    Then the Active tab should show "desktop · 1 connected" on next refresh
    # [Screenshot: count-3-open-counts.png]

Feature: Multi-Client — Permission/Question Overlay Dismiss
  Background:
    Given I am logged in
    And Mobile A and Mobile B are both connected to the same session

  Scenario: PermissionRequest dismissed on other client (PERM-DISMISS-1)
    # Normal mode: Write tool triggers permission
    Given the session is in Normal permission mode
    When the assistant tries to use the Write tool
    Then both Mobile A and Mobile B should show the permission overlay
    When Mobile A taps "Allow"
    Then Mobile A's overlay should dismiss immediately (optimistic)
    And Mobile B's overlay should dismiss within 1 second (via PERMISSION_DISMISSED)
    # [Screenshot: perm-dismiss-1-both-cleared.png]

  Scenario: PermissionRequest — second client response is no-op (PERM-DISMISS-2)
    Given both clients show a permission overlay for the same request
    When Mobile A taps "Allow"
    And Mobile B taps "Allow" before receiving the dismiss
    Then the tool should only execute once (no double keystroke)
    And both overlays should dismiss

  Scenario: AskUserQuestion dismissed on other client (ASK-DISMISS-1)
    When the assistant calls AskUserQuestion with options
    Then both Mobile A and Mobile B should show the question overlay
    When Mobile A selects an option
    Then Mobile A's overlay should dismiss immediately (optimistic)
    And Mobile B's overlay should dismiss when TOOL_DONE arrives
    # [Screenshot: ask-dismiss-1-both-cleared.png]

  Scenario: ExitPlanMode card syncs across clients (PLAN-SYNC-1)
    When the assistant calls ExitPlanMode with a plan
    Then both Mobile A and Mobile B should show the plan card with Approve/Reject buttons
    And neither client should show a permission overlay (Deny/Allow)
    # Regression: CLI fires PermissionRequest for ExitPlanMode, but mobile
    # must skip it — plan card provides its own approval UI.
    When Mobile A taps "Approve"
    Then Mobile A's card should switch to read-only (optimistic, hasUserAfter)
    And Mobile B's card should switch to read-only when the approval message syncs via JSONL
    # [Screenshot: plan-sync-1-both-readonly.png]

  Scenario: ExitPlanMode does not show permission overlay (PLAN-NO-OVERLAY-1)
    # Regression: ExitPlanMode fires PermissionRequest hook, which showed
    # a generic Deny/Allow overlay with raw allowedPrompts JSON.
    # The option indices (0=allow, 2=deny) don't match the CLI's plan
    # selector options, causing wrong behavior.
    Given the session is in Normal permission mode
    When the assistant calls ExitPlanMode with a plan
    Then the plan card with Approve/Reject/YOLO buttons should appear
    And NO permission overlay (Deny/Allow) should appear
    And the user should be able to interact with the plan card directly
    # [Screenshot: plan-no-overlay-1.png]

  Scenario: New permission request replaces dismissed one (PERM-DISMISS-3)
    Given Mobile A dismissed a permission overlay
    When a new permission request arrives before the dismiss reaches Mobile B
    Then Mobile B should show the NEW request (not dismiss it)

# =============================================================================
# PWA — Installation & Standalone Mode
# =============================================================================

Feature: PWA Installation
  The app should be installable as a standalone PWA from the home screen.

  Scenario: PWA manifest is served correctly
    When I open the app URL in Safari
    Then the browser should serve /manifest.webmanifest with correct JSON
    And it should contain name "CodeTap", display "standalone", 3 icons
    And the HTML should include <link rel="manifest">
    And the HTML should include <meta name="theme-color" content="#09090b">
    And the HTML should include <link rel="apple-touch-icon">

  Scenario: Add to Home Screen
    Given I am logged into the app in Safari
    When I tap Share → Add to Home Screen
    Then the "Add to Home Screen" dialog should show
    And the app name should be "CodeTap"
    And the icon should display the CodeTap logo (not a generic icon)
    When I tap "Add"
    Then the CodeTap icon should appear on the home screen
    # [Screenshot: pwa-homescreen-icon.png]

  Scenario: Standalone mode — no Safari chrome
    Given CodeTap is installed on the home screen
    When I launch CodeTap from the home screen
    Then the app should open in standalone mode (no Safari address bar)
    And the status bar should use dark theme (#09090b)
    And the login page should be displayed (separate cookie jar from Safari)
    # [Screenshot: pwa-standalone-login.png]

  Scenario: Standalone mode — login and session list
    Given CodeTap is open in standalone mode
    When I login with the correct password
    Then the sessions list should display
    And there should be no browser navigation controls visible
    # [Screenshot: pwa-standalone-sessions.png]

# =============================================================================
# PWA — Push Notification Subscription
# =============================================================================

Feature: Push Notification Subscription
  Users can subscribe to push notifications from the PWA.

  Scenario: Bell icon only visible in standalone PWA mode
    Given I am logged into the app in Safari (regular browser tab)
    Then the notification bell icon should NOT appear in the header
    # Reason: PushManager is not available outside standalone mode on iOS

  Scenario: Bell icon visible in standalone PWA mode
    Given I am logged into the app in standalone PWA mode
    Then a bell icon (BellOff) should appear in the header next to Logout
    And it should be titled "Enable notifications"
    # [Screenshot: pwa-bell-off.png]

  Scenario: Subscribe to push notifications
    Given the bell icon is visible (BellOff state)
    When I tap the bell icon
    Then the browser should show a notification permission prompt
    When I allow notifications
    Then the bell icon should change to BellOn (filled)
    And the server should have a stored push subscription
    # [Screenshot: pwa-bell-on.png]

  Scenario: Unsubscribe from push notifications
    Given push notifications are enabled (BellOn state)
    When I tap the bell icon
    Then the bell icon should change back to BellOff
    And the server should remove the push subscription

# =============================================================================
# PWA — Push Notification Triggers
# =============================================================================

Feature: Push Notification Triggers
  Push notifications should fire only when the user is NOT viewing the session.

  Background:
    Given push notifications are enabled on the mobile PWA
    And there is an active Claude session "A" in project "my-project"

  Scenario: No notification when viewing the session (session-idle)
    Given I am connected to session A in ChatView
    When Claude completes a response in session A (Stop hook fires)
    Then I should see the response via WebSocket (TURN_COMPLETE)
    And I should NOT receive a push notification
    And the app badge should NOT increment

  Scenario: Notification when not viewing the session (session-idle)
    Given I am on SessionsView (not connected to any session)
    When Claude completes a response in session A
    Then I should receive a push notification:
      | title | Claude finished |
      | body  | Turn complete in my-project |
    And the app icon badge should show "1"
    # [Screenshot: pwa-push-session-idle.png]

  Scenario: Notification when viewing a different session
    Given I am connected to session B in ChatView
    And session A completes a response
    Then I should receive a push notification for session A
    And the app icon badge should increment

  Scenario: Notification for permission request
    Given I am on SessionsView
    When Claude in session A requests permission for "Bash"
    Then I should receive a push notification:
      | title | Permission needed |
      | body  | Bash in my-project |
    And the app icon badge should increment
    # [Screenshot: pwa-push-permission.png]

  Scenario: Notification for AskUserQuestion
    Given I am on SessionsView
    When Claude in session A uses AskUserQuestion
    Then I should receive a push notification:
      | title | Question from Claude |
      | body  | Waiting for answer in my-project |
    And the app icon badge should increment

  Scenario: No notification flood during active conversation
    Given I am connected to session A in ChatView
    When Claude completes 10 responses in rapid succession
    Then I should receive 0 push notifications
    And the app icon badge should remain unchanged

  Scenario: App in background receives notification
    Given I am connected to session A in ChatView
    When I switch to the home screen (app goes to background)
    And the WebSocket disconnects (after ~2-3 seconds)
    And Claude completes a response in session A
    Then I should receive a push notification
    And the app icon badge should show "1"
    # [Screenshot: pwa-push-background.png]

  Scenario: Multiple sessions notify independently
    Given sessions A, B, and C are all active
    And I am not connected to any session
    When session A completes → push, badge=1
    And session B requests permission → push, badge=2
    And session C asks a question → push, badge=3
    Then the notification center should show 3 notifications
    And the app icon badge should show "3"

# =============================================================================
# PWA — Notification Click & Navigation
# =============================================================================

Feature: Notification Click Navigation
  Tapping a notification should navigate to the correct session.

  Scenario: Click notification when app is open
    Given the app is open on SessionsView
    And I received a notification for session A
    When I tap the notification
    Then the app should focus (bring to foreground)
    And the app should navigate to session A's ChatView
    And session A's pending count should clear
    # [Screenshot: pwa-notification-click-open.png]

  Scenario: Click notification when app is closed
    Given the app is not open
    And I received a notification for session A
    When I tap the notification
    Then the app should open with URL /?session=<sessionId>
    And after login, the app should navigate to session A's ChatView
    # [Screenshot: pwa-notification-click-closed.png]

  Scenario: URL parameter ?session= parsed on app load
    Given the app is freshly opened with URL /?session=abc123
    When I login
    Then the app should automatically navigate to session abc123
    And the URL should be cleaned up (no ?session= in address)

# =============================================================================
# PWA — Badge Count & Pending Indicators
# =============================================================================

Feature: Badge Count Management
  App icon badge and session card indicators track unread notifications.

  Background:
    Given push notifications are enabled
    And sessions A (1 pending), B (1 pending), C (1 pending) have notifications
    And the app icon badge shows "3"

  Scenario: Badge decrements when entering a session
    When I open the app and navigate to session A
    Then session A's pending count should be cleared
    And the app icon badge should update to "2"
    And SessionsView should show badges on B and C (not A)

  Scenario: Badge clears to zero when all sessions viewed
    When I navigate to session A → badge=2
    And I navigate to session B → badge=1
    And I navigate to session C → badge=0
    Then the app icon badge should be cleared completely

  Scenario: Pending indicators on Active Sessions list
    Given I am on the Active tab in SessionsView
    Then sessions with pending notifications should show a red badge with count
    And sessions without pending notifications should show no badge
    # [Screenshot: pwa-pending-badges.png]

  Scenario: Pending indicators update in real-time via SW
    Given I am on the Active tab in SessionsView
    When a new push notification arrives for session B
    Then session B's badge should update without waiting for polling
    # (SW postMessage → app refetches pending counts)

  Scenario: Notification tag deduplication
    Given session B completes 3 times while I am away
    Then the notification center should show only 1 notification for B (latest replaces previous)
    But the app icon badge should count all 3 (badge = 3 if B is the only pending session)
    When I enter session B
    Then all 3 pending counts for B are cleared at once
    And badge drops to 0

# =============================================================================
# PWA — HTTPS & Certificate
# =============================================================================

Feature: HTTPS Support
  The server supports HTTPS for PWA push notification requirements.

  Scenario: Server auto-detects HTTPS certificates
    Given ~/.codetap/cert.pem and ~/.codetap/key.pem exist
    When the server starts
    Then it should listen on HTTPS
    And the startup log should show "https://0.0.0.0:PORT (HTTPS)"

  Scenario: Server falls back to HTTP without certificates
    Given ~/.codetap/cert.pem does NOT exist
    When the server starts
    Then it should listen on HTTP (default behavior)
    And the startup log should show "http://0.0.0.0:PORT"

  Scenario: codetap cert command generates self-signed certificate
    When I run "codetap cert"
    Then ~/.codetap/cert.pem and ~/.codetap/key.pem should be created
    And the certificate should include the machine's local IP as SAN
    And instructions for trusting on iOS and Android should be printed

  Scenario: Tailscale HTTPS works for PWA
    Given the server is running with Tailscale TLS certificates
    When I open the app on a mobile device via the Tailscale hostname
    Then the HTTPS connection should be established without certificate errors
    And the PWA should be installable
    And push notifications should work (secure context satisfied)

  Scenario: Permission request works in HTTPS mode
    Given ~/.codetap/cert.pem and ~/.codetap/key.pem exist
    And the server is running in HTTPS mode
    And Claude is in Normal permission mode
    When Claude requests permission for a Write tool
    Then the permission overlay should appear on mobile
    And tapping Allow should approve the tool in CLI
    And the tool should execute successfully

  Scenario: Streaming text works in HTTPS mode
    Given the server is running in HTTPS mode
    When Claude generates a long response
    Then streaming text should appear incrementally on mobile
    And the StatusBar should show context usage percentage
    And the final response should display completely

# =============================================================================
# PWA — Service Worker
# =============================================================================

Feature: Service Worker Lifecycle
  The service worker handles precaching, push events, and notification clicks.

  Scenario: Service worker registers on app load
    When the app loads for the first time
    Then a service worker should register successfully
    And static assets should be precached

  Scenario: Service worker auto-updates
    When a new version of the app is deployed
    And the user opens the app
    Then the service worker should auto-update (registerType: autoUpdate)
    And the new version should be active on next navigation

  Scenario: Push event with badge=0 clears app badge
    When the server sends a silent push with { data: { badge: 0 } }
    Then the service worker should call navigator.clearAppBadge()
    And no notification should be shown (silent push, no title)


# =============================================================================
# REGRESSION — Tool Status After Permission Deny & Interrupt
# =============================================================================
# Added: 2026-03-21
# Root cause: TURN_COMPLETE handler skipped markToolsAs() when interruptedRef
# was true, leaving denied tool cards stuck in "running/loading" state forever.
# Fix: TURN_COMPLETE now always calls markToolsAs() with the appropriate status
# ('interrupted' if interrupted, 'success' otherwise).

Feature: Regression — Tool Status After Permission Deny
  Background:
    Given I am logged in
    And permission mode is "Normal"
    And I open a new chat

  Scenario: Single tool deny — tool card shows interrupted icon (not loading)
    When I send "Create a file called /tmp/deny-regression.txt with 'test'"
    Then a Write tool card should appear with running status (spinner)
    And a permission overlay should appear with Allow and Deny buttons
    # [Screenshot: deny-reg-T0-overlay.png]
    When I tap "Deny"
    Then the permission overlay should dismiss
    And the Write tool card should show the interrupted icon (🚫), NOT a spinner
    And "Interrupted · What should Claude do instead?" should appear
    And the input placeholder should change to "What should Claude do instead?"
    # [Screenshot: deny-reg-T1-interrupted-icon.png]
    # Previously: tool card stayed as spinner/loading forever

  Scenario: Multi-tool deny — completed tools keep success, denied tool shows interrupted
    # This is the critical regression: previously ALL tool cards reverted to loading
    When I send "Read package.json then create /tmp/multi-deny.txt with the name"
    # T0: Read tool starts (auto-approved) → completes → ✅ green checkmark
    Then a Read tool card should appear and complete with green checkmark
    # [Screenshot: multi-deny-T0-read-success.png]

    # T1: Write tool starts → permission overlay appears
    Then a Write tool card should appear with running status
    And a permission overlay should appear
    # [Screenshot: multi-deny-T1-write-permission.png]

    # T2: User denies → CLI interrupts → TURN_COMPLETE fires
    When I tap "Deny"
    Then the permission overlay should dismiss
    And the Read tool card MUST still show ✅ green checkmark (NOT revert to loading)
    And the Write tool card should show 🚫 interrupted icon
    And "Interrupted · What should Claude do instead?" should appear
    # [Screenshot: multi-deny-T2-final-state.png]
    # CRITICAL: Read tool status must NOT regress from success to loading/running

  Scenario: Deny does not create the file
    When I send "Create /tmp/deny-file-check.txt with 'should not exist'"
    And the permission overlay appears
    When I tap "Deny"
    Then /tmp/deny-file-check.txt should NOT exist


Feature: Regression — Tool Status After User Abort (Stop Button)
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Abort during streaming — completed tools keep success
    Given permission mode is "YOLO" (to avoid permission overlay interference)
    When I send a request that triggers multiple tools (e.g. "Read all .ts files")
    And some tools complete with ✅ while Claude is still streaming
    When I tap the stop button
    Then completed tools MUST still show ✅ green checkmark
    And any running tools should show 🚫 interrupted icon
    And "Interrupted · What should Claude do instead?" should appear
    # [Screenshot: abort-multi-tool-result.png]

  Scenario: Abort then re-send — tool cards start fresh
    Given I aborted a previous turn
    When I send a new message
    Then new tool cards should appear with running status
    And old interrupted tool cards should remain in history (not removed)
    And the new tools should complete normally


Feature: Regression — Tool Status After CLI Interrupt (Ctrl+C)
  # Desktop user presses Ctrl+C in tmux — mobile should reflect the interrupt
  Background:
    Given I am logged in
    And I have a desktop session connected from mobile

  Scenario: Desktop Ctrl+C during multi-tool — completed tools keep success on mobile
    Given Claude is executing multiple tools (Read, Grep, etc.) visible on mobile
    And some tools have completed (✅) while others are still running
    When the desktop user presses Ctrl+C in the tmux terminal
    Then on mobile:
      - Completed tools MUST still show ✅ green checkmark
      - Running tools should show 🚫 interrupted icon
      - "Interrupted · What should Claude do instead?" should appear
      - The streaming indicator should disappear
    # [Screenshot: cli-interrupt-multi-tool.png]
    # Previously: CLI interrupt caused all tool cards to stay as loading spinners


Feature: Regression — HTTPS Hook Configuration
  # Bug: hook-config.ts hardcoded http:// URLs even when server ran on HTTPS
  # Root cause: _isHttps() was removed during TS migration, hookUrl was hardcoded
  # Fix: auto-detect HTTPS from cert file existence, use correct protocol + curl -k
  Background:
    Given ~/.codetap/cert.pem and ~/.codetap/key.pem exist
    And the server is running in HTTPS mode

  Scenario: Hooks use HTTPS URLs when server runs on HTTPS
    When the server starts and installs hooks
    Then ~/.claude/settings.json hook commands should contain "https://localhost"
    And curl commands should include the "-k" flag (for self-signed certs)
    # Previously: hooks used "http://localhost" → SSL connection error → all hooks silent

  Scenario: Permission overlay appears when HTTPS hooks are correctly configured
    Given hooks are installed with HTTPS URLs
    And permission mode is "Normal"
    When Claude requests permission for a Write tool
    Then the permission overlay should appear on mobile (within 5 seconds)
    And the countdown timer should be visible
    And Allow/Deny buttons should be functional
    # Previously: overlay never appeared because HTTP hooks couldn't reach HTTPS server

  Scenario: Hooks use HTTP URLs when server runs on HTTP
    Given no cert files exist
    And the server is running in HTTP mode
    When the server starts and installs hooks
    Then ~/.claude/settings.json hook commands should contain "http://localhost"
    And curl commands should NOT include the "-k" flag


Feature: Regression — Voice Input Secure Context
  # Voice input (Web Speech API) requires secure context (HTTPS or localhost)
  Background:
    Given I am logged in
    And I open a new chat

  Scenario: Mic button visible in HTTPS context
    Given the app is loaded over HTTPS (or localhost)
    Then a microphone button should be visible in the input bar
    And it should be positioned between the image button and the textarea

  Scenario: Mic button hidden in HTTP context
    Given the app is loaded over plain HTTP (e.g. http://192.168.1.x:3456)
    Then no microphone button should be visible
    # Web Speech API requires secure context; button hidden via isSecureContext check

  Scenario: Voice recording toggle
    Given the mic button is visible (HTTPS context)
    When I tap the mic button
    Then the button should pulse red (recording indicator)
    And the browser should request microphone permission (if not already granted)
    When I tap the mic button again
    Then recording should stop
    And the button should return to its default gray state

  Scenario: Voice transcript appends to existing text
    Given I have typed "hello " in the input field
    When I activate voice input and say "world"
    Then the input field should contain "hello world" (appended, not replaced)
    And the message should NOT auto-send (user reviews before pressing Send)


# =============================================================================
# Feature: Insight Block Rendering
# =============================================================================

Feature: Insight Block Display

  Scenario: Insight block renders as collapsible card
    Given I have an active chat session with an Insight block in the response
    Then the Insight block shows as a collapsed card
    And the card shows "★ Insight" label with a summary
    And a chevron icon is visible

  Scenario: Insight block expands on tap
    Given I see a collapsed Insight card
    When I tap the Insight card
    Then the card expands to show full markdown content
    And the chevron changes to up arrow

  Scenario: Insight block collapses on second tap
    Given I see an expanded Insight card
    When I tap the Insight card again
    Then the card collapses back to summary view

  Scenario: Multiple Insight blocks in one message
    Given I have a response with two Insight blocks separated by text
    Then both render as separate collapsible cards
    And the text between them renders as normal markdown

  Scenario: Message without Insight blocks renders normally
    Given I have a response with no Insight delimiters
    Then the message renders as plain markdown

  Scenario: Insight block in reconnected session history
    Given I reconnect to a session that had Insight blocks
    Then the Insight blocks render correctly as collapsible cards


# =============================================================================
# MULTI-ADAPTER UI
# =============================================================================

Feature: Multi-Adapter — New Chat (Adapter Selection)
  Background:
    Given I am logged in
    And I am viewing sessions within a project

  Scenario: New Chat shows Hero Icon adapter selection screen
    When I tap "New Chat"
    Then I should see an adapter selection screen
    And it should display Hero Icons for each available adapter
    And the available adapters should include "Claude" and "Codex"
    # [Screenshot: adapter-selection.png]

  Scenario: Selecting Claude shows Claude-specific options
    When I tap "New Chat"
    And I select the "Claude" adapter
    Then I should see Claude-specific settings cards:
      | Setting   | Options                   |
      | Model     | Sonnet / Opus / Haiku     |
      | Thinking  | Off / Normal / Extended   |
    And the input placeholder should reflect Claude
    # [Screenshot: new-chat-claude-options.png]

  Scenario: Selecting Codex shows Codex-specific options
    When I tap "New Chat"
    And I select the "Codex" adapter
    Then I should see Codex-specific settings cards:
      | Setting           | Options                     |
      | Model             | GPT-5.4 / o3               |
      | Reasoning Effort  | Low / Medium / High / XHigh |
    And the input placeholder should reflect Codex
    # [Screenshot: new-chat-codex-options.png]

  Scenario: Settings cards cycle to next option on tap
    Given I selected the "Claude" adapter
    And the Model card shows "Sonnet"
    When I tap the Model card
    Then the Model card should cycle to "Opus"
    When I tap the Model card again
    Then the Model card should cycle to "Haiku"
    When I tap the Model card again
    Then the Model card should cycle back to "Sonnet"

  Scenario: Per-adapter preferences persist across sessions
    Given I selected the "Claude" adapter
    And I set Model to "Opus" and Thinking to "Extended"
    When I navigate away and tap "New Chat" again
    And I select the "Claude" adapter
    Then Model should still be "Opus" and Thinking should still be "Extended"
    And Codex preferences should be independent (unchanged)

  Scenario: "Switch to [other]" link swaps adapter, options, and input placeholder
    Given I selected the "Claude" adapter
    Then a link "Switch to Codex" should be visible
    When I tap "Switch to Codex"
    Then the adapter should switch to Codex
    And the settings cards should update to Codex-specific options
    And the input placeholder should update to reflect Codex
    And a link "Switch to Claude" should now be visible
    # [Screenshot: switch-adapter-link.png]

  Scenario: Sending a prompt navigates to chat view with correct adapter
    Given I selected the "Claude" adapter
    And I type "Hello Claude" in the input field
    When I tap Send
    Then I should navigate to the chat view
    And the StatusBar should show "Claude" as the adapter
    And the message should be sent to the Claude CLI


Feature: Multi-Adapter — Session List
  Background:
    Given I am logged in
    And I have sessions from both Claude and Codex adapters

  Scenario: Session list shows adapter tabs (All / Claude / Codex)
    When I view sessions within a project
    Then I should see adapter filter tabs: "All", "Claude", "Codex"
    And "All" should be selected by default
    # [Screenshot: session-list-adapter-tabs.png]

  Scenario: Tapping a tab filters sessions by adapter
    Given I am viewing the session list
    When I tap the "Claude" tab
    Then only Claude sessions should be visible
    When I tap the "Codex" tab
    Then only Codex sessions should be visible

  Scenario: Each session row shows adapter badge (Claude=amber, Codex=green)
    When I view the session list
    Then each session row should display an adapter badge
    And Claude sessions should show an amber "Claude" badge
    And Codex sessions should show a green "Codex" badge
    # [Screenshot: session-row-adapter-badges.png]

  Scenario: "All" tab shows sessions from both adapters sorted by time
    Given I have sessions from both adapters with different timestamps
    When I tap the "All" tab
    Then sessions from both Claude and Codex should be visible
    And they should be sorted by most recent activity (newest first)


Feature: Multi-Adapter — StatusBar
  Background:
    Given I am logged in
    And I have an active chat session

  Scenario: StatusBar shows adapter badge instead of "tmux"
    When I view an active chat session
    Then the StatusBar should show an adapter badge instead of "tmux"
    And the badge should display the adapter name

  Scenario: Claude sessions show amber "Claude" badge
    Given I am viewing a Claude chat session
    Then the StatusBar should show an amber "Claude" badge
    # [Screenshot: statusbar-claude-badge.png]

  Scenario: Codex sessions show green "Codex" badge
    Given I am viewing a Codex chat session
    Then the StatusBar should show a green "Codex" badge
    # [Screenshot: statusbar-codex-badge.png]


Feature: Cross-AI Review — Message Action Buttons
  Background:
    Given I am logged in
    And I have an active Claude chat session with at least one completed assistant turn
    And both Claude and Codex adapters are available

  Scenario: Action buttons appear on completed assistant messages
    # T0: Assistant message is fully rendered (not streaming)
    When I view a completed assistant message
    Then I should see action buttons below the message
    And the buttons should include "Copy" and "Send to Codex"
    And "Send to Codex" should display the target adapter name dynamically
    # [Screenshot: message-action-buttons.png]

  Scenario: Action buttons NOT shown on user messages
    When I view a user message in the chat
    Then no action buttons should appear below the user message
    # Action buttons are only for assistant responses

  Scenario: Action buttons NOT shown during streaming
    # T0: AI is actively streaming a response
    Given the AI is currently streaming a response
    Then the streaming message should NOT show action buttons
    # T1: Streaming completes
    When the AI response finishes streaming
    Then action buttons should appear below the completed message
    # [Screenshot: buttons-appear-after-streaming.png]

  Scenario: Action buttons NOT shown when only one adapter is available
    Given only the Claude adapter is available (Codex unavailable)
    When I view a completed assistant message
    Then only the "Copy" button should appear
    And no "Send to" button should be visible
    # "Send to [Adapter]" requires at least one other available adapter

  Scenario: Action buttons NOT shown in empty or new chat
    Given I am in a new chat with no messages
    Then no action buttons should be visible anywhere
    When I send a message
    And the AI has not yet responded
    Then no action buttons should be visible

  Scenario: Adapter name is dynamic based on available adapters
    Given I am in a Codex chat session
    And the Claude adapter is available
    When I view a completed assistant message
    Then the action button should read "Send to Claude" (not "Send to Codex")
    # The button always shows the OTHER adapter, not the current one

  Scenario: Copy button copies message text to clipboard
    Given I see a completed assistant message with action buttons
    When I tap the "Copy" button
    Then the message content should be copied to the clipboard
    And the "Copy" button should briefly show a success indicator
    # [Screenshot: copy-success-indicator.png]


Feature: Cross-AI Review — Review Action Menu
  Background:
    Given I am logged in
    And I have an active Claude chat session with a completed assistant message
    And both Claude and Codex adapters are available

  Scenario: Tapping "Send to [Adapter]" opens modal with template options
    When I tap the "Send to Codex" button on an assistant message
    Then a popup menu should appear with the following template options:
      | Template              |
      | Direct send           |
      | Code Review           |
      | Suggest alternatives  |
      | Custom instruction... |
    # [Screenshot: review-action-menu.png]

  Scenario: Selecting "Custom instruction..." shows inline text input
    When I tap the "Send to Codex" button on an assistant message
    And I tap "Custom instruction..."
    Then an inline text input field should appear within the menu
    And the input should have a placeholder like "Enter your instruction..."
    And the input should be focused and keyboard visible
    # [Screenshot: custom-instruction-input.png]

  Scenario: Custom instruction submits on Enter
    Given the custom instruction input is visible
    When I type "Compare this with the official docs" in the input
    And I press Enter
    Then the review should be created with the custom instruction
    And the menu should close

  Scenario: Backdrop tap dismisses the action menu
    Given the review action menu is visible
    When I tap the backdrop (area outside the menu)
    Then the menu should dismiss
    And no review should be created

  Scenario: Menu state resets on reopen (custom input not stale)
    Given I opened the review action menu and typed in the custom input
    When I dismiss the menu by tapping the backdrop
    And I tap "Send to Codex" again
    Then the menu should show the initial template list (not the custom input)
    And the custom input field should be empty


Feature: Cross-AI Review — Creating a Review
  Background:
    Given I am logged in
    And I have an active Claude chat session with multiple completed turns
    And both Claude and Codex adapters are available

  Scenario: Selecting a template creates child session and opens floating panel
    # --- Timeline: Creating a Review ---
    # T0: User taps "Send to Codex" on an assistant message
    When I tap "Send to Codex" on an assistant message
    And I select "Code Review" from the template menu
    # T1: Server creates child session, floating panel appears
    Then a floating panel should appear at the bottom of the screen
    And the panel should occupy roughly the lower half of the viewport
    And the parent chat should still be partially visible above the panel
    # [Screenshot: T1-floating-panel-opened.png]

  Scenario: Panel shows adapter brand color and dynamic title
    Given I started a "Code Review" review with Codex
    When the floating panel appears
    Then the panel header should show "Codex Code Review" as the title
    And the header should use the Codex brand color (green)
    And an "End" button should be visible in the panel header
    # [Screenshot: panel-header-brand-color.png]

  Scenario: Panel title reflects selected template
    When I tap "Send to Codex" and select "Direct send"
    Then the panel title should show "Codex Direct Send"
    When I start another review and select "Suggest alternatives"
    Then the panel title should show "Codex Suggest Alternatives"
    When I start another review with a custom instruction "Check error handling"
    Then the panel title should show "Codex Check Error Handling" (truncated if long)

  Scenario: Child session runs in same cwd as parent
    Given the parent session is running in "/Users/me/my-project"
    When I start a review with Codex
    Then the child Codex session should launch in "/Users/me/my-project"
    And the child session should have codebase access in that directory

  Scenario: Context includes conversation history up to anchor message
    Given the parent chat has 10 messages (5 user + 5 assistant turns)
    When I tap "Send to Codex" on the 3rd assistant message
    And I select "Code Review"
    Then the child session should receive context including:
      | Content                                    |
      | Parent conversation history (messages 1-6) |
      | The anchor message marked for review       |
      | The "Code Review" instruction              |

  Scenario: Context capped at 50 messages / 30KB
    Given the parent chat has 80 messages totaling 50KB
    When I start a review on a recent assistant message
    Then the context sent to the child should include at most 50 messages
    And the total context size should not exceed 30KB
    And if truncated, the context should begin with "[Earlier conversation omitted]"


Feature: Cross-AI Review — Floating Panel Interaction
  Background:
    Given I am logged in
    And I have an active review with a Codex child session
    And the floating panel is expanded

  Scenario: Panel shows child messages with streaming
    # T0: Child session is processing the review request
    When the child AI begins responding
    Then I should see the child's response streaming in the floating panel
    And the streaming indicator should be visible in the panel
    # T1: Child response completes
    When the child AI finishes responding
    Then the full response should be visible in the panel
    # [Screenshot: T1-child-response-complete.png]

  Scenario: Panel has its own input field with distinct placeholder
    When I look at the floating panel
    Then I should see an input field at the bottom of the panel
    And the placeholder should be distinct from the parent input (e.g. "Ask Codex...")
    When I type "Can you elaborate on point 3?" in the panel input
    And I tap Send in the panel
    Then the message should be sent to the child session (not the parent)
    And the child AI should begin responding in the panel

  Scenario: Handle bar minimizes panel to pill button
    When I tap the handle bar at the top of the floating panel
    Then the panel should minimize
    And a pill-shaped button should appear in the bottom-right corner
    And the pill should show the adapter name and template (e.g. "Codex Code Review")
    And the pill should have a pulsing dot indicating an active review
    # [Screenshot: minimized-pill-button.png]

  Scenario: Pill tap re-expands the floating panel
    Given the floating panel is minimized to a pill
    When I tap the pill button
    Then the floating panel should re-expand to its previous size
    And the child session messages should still be visible
    And the scroll position should be preserved

  Scenario: Each child assistant message has Copy and "Send to [Parent]" buttons
    When a child assistant message is fully rendered
    Then I should see "Copy" and "Send to Claude" buttons below the message
    And "Send to Claude" should use the parent adapter name dynamically
    # [Screenshot: child-message-action-buttons.png]


Feature: Cross-AI Review — Send Back to Parent
  Background:
    Given I am logged in
    And I have an active review with a Codex child session
    And the child AI has completed at least one response

  Scenario: "Send to [Parent]" injects formatted feedback into parent
    # T0: Child response is visible in the floating panel
    When I tap "Send to Claude" on a child assistant message
    # T1: Feedback is injected into the parent session
    Then the parent chat should receive a new message prefixed with "[Review feedback from Codex]:"
    And the message content should contain the child's response text
    # T2: Parent AI responds to the feedback
    And the parent AI should begin processing the feedback
    # [Screenshot: T2-parent-receiving-feedback.png]

  Scenario: Parent AI responds to the injected feedback
    Given I sent a child message back to the parent via "Send to Claude"
    When the parent AI finishes responding to the feedback
    Then the parent's response should be visible in the parent chat
    And the parent should reference or address the review feedback
    And the floating panel should remain open (review is still active)

  Scenario: "Send to [Parent]" button disabled when parent is streaming
    Given the parent AI is currently streaming a response
    When I look at a child assistant message's action buttons
    Then the "Send to Claude" button should be disabled (greyed out)
    And tapping the disabled button should show a toast: "Wait for the current turn to complete"
    # [Screenshot: send-to-parent-disabled.png]

  Scenario: 409 returned when parent is busy
    Given the parent session is currently processing a message
    When I attempt to send a child message back to the parent
    Then the server should respond with a 409 Conflict status
    And a toast should notify me that the parent is busy
    And the child message should remain unsent (can retry later)


Feature: Cross-AI Review — Ending a Review
  Background:
    Given I am logged in
    And I have an active review with a Codex child session
    And the floating panel is visible

  Scenario: End button kills child session and panel disappears
    # T0: Floating panel is visible with active child session
    When I tap the "End" button in the panel header
    # T1: Child tmux session is terminated, panel disappears
    Then the floating panel should disappear
    And the minimized pill should also disappear (if it was visible)
    And the parent chat should return to its full-height layout
    # [Screenshot: T1-review-ended.png]

  Scenario: JSONL preserved for history after ending
    Given I ended the review by tapping "End"
    When I navigate away and return to the parent session later
    Then the ended review should be visible as a collapsed card in the history
    And the child session's conversation data should be preserved

  Scenario: Can start a new review after ending the previous one
    Given I ended a review
    When I tap "Send to Codex" on another assistant message
    And I select a template
    Then a new review should start successfully
    And a new floating panel should appear
    And the previous ended review should remain as a collapsed card in history


Feature: Cross-AI Review — One Active Review Constraint
  Background:
    Given I am logged in
    And I have an active Claude chat session
    And both Claude and Codex adapters are available

  Scenario: Only one active review at a time
    Given I have an active review with Codex running
    When I view the parent chat
    Then I should see exactly one floating panel (or pill)
    And there should be no way to have two panels simultaneously

  Scenario: Second review attempt shows confirmation dialog
    Given I have an active review with Codex running
    When I tap "Send to Codex" on a different assistant message
    And I select "Direct send" from the template menu
    Then a confirmation dialog should appear
    And the dialog should say "End current review to start a new one?"
    And the dialog should have "Confirm" and "Cancel" buttons
    # [Screenshot: confirm-end-review-dialog.png]

  Scenario: Confirming ends first review and starts new one
    Given the confirmation dialog is visible
    When I tap "Confirm"
    Then the current review should end (child session terminated)
    And a new review should start with the newly selected message and template
    And the floating panel should show the new review's content

  Scenario: Cancelling keeps existing review
    Given the confirmation dialog is visible
    When I tap "Cancel"
    Then the dialog should dismiss
    And the existing review should remain active
    And the floating panel should continue showing the current review


Feature: Cross-AI Review — Session Filtering
  Background:
    Given I am logged in
    And I have an active Claude chat session with an active Codex review child

  Scenario: Child session NOT shown in session list
    When I navigate to the session list
    Then the Codex child session should NOT appear in the session list
    And only the parent Claude session should be listed
    # Child sessions are filtered out at the API layer

  Scenario: Child session NOT shown in active sessions tab
    When I view the active sessions tab
    Then the Codex child session should NOT appear as an active session
    And only the parent Claude session should show as active

  Scenario: Active session count excludes child sessions
    Given the parent Claude session is active
    And the child Codex review session is active
    When I view the session count badge
    Then the count should show 1 active session (not 2)
    # Child sessions do not inflate the active count

  Scenario: Push notifications suppressed for child sessions
    Given the child Codex session produces an output event
    When I am not viewing the parent chat (e.g. on the session list)
    Then no push notification should appear for the child session
    # Notifications for child sessions would be confusing to the user


Feature: Cross-AI Review — History View
  Background:
    Given I am logged in
    And I have a parent Claude session with one ended Codex review
    And the review was anchored to a specific assistant message

  Scenario: Block-start marker appears at anchor message position
    When I scroll to the assistant message that triggered the review
    Then a block-start marker should appear after the anchor message
    And the marker should read "Codex Code Review started" (adapter + template)
    And the marker should be styled as a horizontal divider with label
    # [Screenshot: block-start-marker.png]

  Scenario: Collapsed card shows adapter, title, count, and summary
    When I view the block-start marker area
    Then a collapsed review card should appear immediately after the marker
    And the card should display:
      | Field   | Example                              |
      | Adapter | Codex                                |
      | Title   | Code Review                          |
      | Count   | 4 messages                           |
      | Summary | First line of the child AI's response |
    And the card should show "Tap to expand" hint
    # [Screenshot: collapsed-review-card.png]

  Scenario: Block-end marker appears after collapsed card for ended reviews
    When I view the area below the collapsed review card
    Then a block-end marker should appear: "Review ended"
    And the marker should be styled similarly to the block-start marker
    # [Screenshot: block-end-marker.png]

  Scenario: Active review shows "in progress" marker instead of end marker
    Given the review is still active (not ended)
    When I scroll to the anchor message area
    Then the block-start marker should appear
    And the collapsed card should show an "in progress" indicator
    And no block-end marker should be present

  Scenario: Parent messages during review period render normally
    Given the parent received messages while the review was active
    When I scroll through the chat history
    Then parent messages sent during the review period should render normally
    And parent messages should appear below the collapsed review card
    And parent messages should NOT be nested inside the review card

  Scenario: Multiple ended reviews render correctly
    Given the parent session has 3 ended reviews on different messages
    When I scroll through the full chat history
    Then each review should have its own block-start marker, card, and block-end marker
    And the reviews should appear at their respective anchor message positions
    And the chat flow between reviews should be uninterrupted

  Scenario: Tapping collapsed card opens read-only view
    When I tap on a collapsed review card
    Then a read-only panel should open showing the full child conversation
    And the panel should show all child messages in order
    And no input field should be present (read-only)
    And a close button should be available to dismiss the panel
    # [Screenshot: read-only-review-panel.png]

  Scenario: Compacted anchor message shows card at end as fallback
    Given the anchor message was compacted or is no longer individually identifiable
    When I view the chat history
    Then the collapsed review card should appear at the end of the visible messages
    And a note should indicate the original anchor position is unavailable


Feature: Cross-AI Review — Reconnect & Persistence
  Background:
    Given I am logged in
    And I have an active Claude chat session with an active Codex review

  Scenario: Page refresh restores the floating panel
    # T0: Floating panel is visible with active child session
    When I refresh the browser page
    # T1: Page reloads and reconnects
    Then the floating panel should reappear automatically
    And the child session messages should be restored
    And the panel should show the correct adapter and title
    # [Screenshot: T1-panel-restored-after-refresh.png]

  Scenario: Server restart resumes or marks review ended
    # T0: Active review is in progress
    When the server restarts
    And I reconnect to the parent session
    # T1: Server checks if child tmux window still exists
    Then if the child tmux window is found, the review should resume
    And the floating panel should reappear
    Or if the child tmux window is gone, the review should be marked as ended
    And the ended review should appear as a collapsed card in history

  Scenario: WebSocket reconnect restores the panel
    Given the WebSocket connection drops temporarily
    When the WebSocket reconnects
    Then the floating panel should restore to its previous state (expanded or minimized)
    And child session messages should continue streaming if the child is active

  Scenario: Parent session destroyed cascades to end child review
    Given the parent tmux session is killed externally
    When the server detects the parent session is gone
    Then the child review session should be automatically ended
    And the review should be marked with ended_at in the database

  Scenario: Child tmux crash auto-ends the review
    Given the child tmux window crashes or is killed externally
    When the server detects the child session is gone
    Then the review should be automatically marked as ended
    And the floating panel should disappear
    And a toast should notify: "Review session ended unexpectedly"

  Scenario: Navigate away and back restores the panel
    # T0: Floating panel is visible
    When I navigate to the session list
    # T1: Panel is no longer visible (different view)
    And I navigate back to the parent chat session
    # T2: Panel restores
    Then the floating panel should reappear
    And the child session state should be preserved
    # [Screenshot: T2-panel-restored-after-navigation.png]


Feature: Cross-AI Review — Multi-Client
  Background:
    Given I am logged in from two browser tabs (Tab A and Tab B)
    And both tabs are viewing the same parent Claude chat session
    And both Claude and Codex adapters are available

  Scenario: Both tabs see the same review panel
    Given a review is active with a Codex child session
    When I view Tab A
    Then the floating panel should be visible with the child session
    When I switch to Tab B
    Then the floating panel should also be visible with the same child session
    # Both tabs receive the same WebSocket broadcasts

  Scenario: Tab A starts review, Tab B sees panel appear
    # T0: Neither tab has a review panel
    When I start a review from Tab A by tapping "Send to Codex"
    And I select "Code Review" from the template menu
    # T1: Tab A shows the floating panel
    Then Tab A should show the floating panel
    # T2: Tab B receives REVIEW_STARTED broadcast
    When I switch to Tab B
    Then Tab B should also show the floating panel
    And the panel should display the same adapter and title as Tab A
    # [Screenshot: T2-tab-b-panel-synced.png]

  Scenario: Tab A ends review, Tab B sees panel disappear
    Given a review is active and both tabs show the floating panel
    # T0: Tab A taps "End"
    When I tap "End" in the panel header on Tab A
    # T1: Tab A's panel disappears
    Then Tab A's floating panel should disappear
    # T2: Tab B receives REVIEW_ENDED broadcast
    When I switch to Tab B
    Then Tab B's floating panel should also have disappeared
    And both tabs should show the parent chat at full height


Feature: Multi-Adapter — Session Context Menu
  Background:
    Given I am logged in
    And I am viewing the session list

  Scenario: Long-pressing a session row shows context menu bottom sheet
    When I long-press on a session row
    Then a context menu bottom sheet should slide up from the bottom
    And the bottom sheet should display the session's first prompt as a title
    # [Screenshot: session-context-menu.png]

  Scenario: Active sessions show "Use as reference" option
    Given the session is active (currently running)
    When I long-press on the session row
    Then the context menu should show "Use as reference in [Adapter]" option
    And the adapter name should be dynamic (the other available adapter)
    And no "Hand off" option should be present

  Scenario: Inactive sessions show "Use as reference" option
    Given the session is inactive (historical)
    When I long-press on the session row
    Then the context menu should show "Use as reference in [Adapter]" option
    And the adapter name should be dynamic (the other available adapter)

  Scenario: Tapping backdrop dismisses context menu
    Given the context menu bottom sheet is visible
    When I tap the backdrop (area outside the bottom sheet)
    Then the context menu should dismiss
    And I should return to the session list view


Feature: Multi-Adapter — Permission Mode Startup
  Background:
    Given I am logged in

  Scenario: Sessions always start with bypass-permissions flag
    When I start a new chat session (any adapter)
    Then the CLI process should launch with the bypass-permissions flag
    And the StatusBar should reflect the pending permission mode
    # Bypass ensures the session starts without blocking on initial permission setup

  Scenario: After startup, permission mode switches to user's chosen mode
    Given a new session just started with bypass-permissions
    When the CLI process is ready
    Then the permission mode should switch to the user's chosen mode
    And the StatusBar should update to show the active mode (e.g. "Normal")
    # [Screenshot: permission-mode-after-startup.png]

  Scenario: Mid-session permission mode switching works for all 4 modes (Claude)
    Given I have an active Claude chat session
    Then I should be able to cycle through all 4 permission modes:
      | Mode      |
      | Normal    |
      | Auto-edit |
      | Plan      |
      | YOLO      |
    And each mode change should take effect immediately
    And the StatusBar should reflect the current mode

  Scenario: Codex sessions always run in YOLO mode (no approvals)
    Given I start a new Codex chat session
    Then the permission mode should be set to YOLO (-a never)
    And the permission mode label should indicate YOLO
    And no permission mode cycling should be available
    # Codex adapter does not support mid-session permission changes
