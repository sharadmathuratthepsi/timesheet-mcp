#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { GitLabIntegration } from './integrations/gitlab.js';
import { GitHubIntegration } from './integrations/github.js';
import { GoogleCalendarIntegration } from './integrations/googleCalendar.js';
import { OutlookCalendarIntegration } from './integrations/outlookCalendar.js';
import { TokenStorage } from './utils/tokenStorage.js';
import { TimesheetGenerator } from './utils/timesheetGenerator.js';
import { ActivityCache } from './utils/cache.js';
import { ActivityDistributor } from './utils/activityDistributor.js';
import { getWorkingDaysForMonth, getCurrentMonth, parseMonthYear, getWorkingDaysForWeek, getCurrentWeek, parseWeekInput, formatWeekRange, parseDateInput, formatDate, formatDayOfWeek, getWorkingDaysForDateRange } from './utils/dateUtils.js';
import { Config } from './types/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

const CONFIG_FILE = path.join(homedir(), '.timesheet-assistant-mcp-config.json');

class TimesheetAssistantMCPServer {
  private server: Server;
  private gitlab: GitLabIntegration;
  private github: GitHubIntegration;
  private googleCalendar: GoogleCalendarIntegration;
  private outlookCalendar: OutlookCalendarIntegration;
  private tokenStorage: TokenStorage;
  private timesheetGenerator: TimesheetGenerator;
  private activityCache: ActivityCache;
  private activityDistributor: ActivityDistributor;
  private config: Config | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'timesheet-assistant-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.gitlab = new GitLabIntegration();
    this.github = new GitHubIntegration();
    this.googleCalendar = new GoogleCalendarIntegration();
    this.outlookCalendar = new OutlookCalendarIntegration();
    this.tokenStorage = new TokenStorage();
    this.timesheetGenerator = new TimesheetGenerator();
    this.activityCache = new ActivityCache();
    this.activityDistributor = new ActivityDistributor();

    this.setupHandlers();
  }

  private async loadConfig(): Promise<Config> {
    if (this.config) return this.config;

    try {
      const data = await fs.readFile(CONFIG_FILE, 'utf-8');
      this.config = JSON.parse(data);
      return this.config!;
    } catch (error) {
      throw new Error(
        'Configuration file not found. Please create ~/.timesheet-assistant-mcp-config.json with your PSI configuration.'
      );
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: 'configure_psi',
          description: 'Configure PSI (Project Server) timesheet integration with credentials.',
          inputSchema: {
            type: 'object',
            properties: {
              username: {
                type: 'string',
                description: 'PSI username for authentication',
              },
              password: {
                type: 'string',
                description: 'PSI password for authentication',
              },
              url: {
                type: 'string',
                description: 'Optional. PSI timesheet URL. Default: https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx',
              },
            },
            required: ['username', 'password'],
          },
        },
        {
          name: 'get_psi_tasks',
          description: 'ORCHESTRATION TOOL: Get available tasks from PSI Project Server for a specific date and present them to user. This tool fetches the hierarchical task list and returns instructions for the LLM to display it to the user in the same hierarchical tree format.\n\nWHEN TO USE: Use this tool when user wants to fill PSI timesheet. First get tasks, then ask user to select a task by its index number.\n\nOPTIMIZATION: The task list is the SAME for all days in a timesheet period. Call this tool ONCE when starting to submit a multi-day timesheet, NOT once per day. Reuse the same task index for all days in the timesheet.\n\nIMPORTANT: After calling this tool, the LLM MUST present the Hierarchical Tree View to the user exactly as provided by the tool, then ask which task index they want to use.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Date in YYYY-MM-DD format (e.g., "2025-12-05")',
              },
            },
            required: ['date'],
          },
        },
        {
          name: 'submit_to_psi',
          description: 'Submit timesheet to PSI Project Server with selected task. Use get_psi_tasks first to get available tasks and their indices.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Date in YYYY-MM-DD format (e.g., "2025-12-05")',
              },
              taskIndex: {
                type: 'number',
                description: 'Index of the task from get_psi_tasks result (e.g., 3 for "[3] [ENABLED] Some Task")',
              },
              description: {
                type: 'string',
                description: 'Work description (max 255 characters)',
              },
              hours: {
                type: 'string',
                description: 'Optional. Hours worked (e.g., "8h"). Defaults to "8h".',
              },
            },
            required: ['date', 'taskIndex', 'description'],
          },
        },
        {
          name: 'inspect_psi_page',
          description: 'Inspect the PSI timesheet page structure to understand form fields and elements. Useful for debugging.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'generate_timesheet',
          description:
            'ORCHESTRATION TOOL: Returns a detailed guide for building monthly timesheets day-by-day. This tool DOES NOT fetch data - it provides instructions for the LLM to:\n' +
            '1. Create a TODO list for all working days\n' +
            '2. Fetch data for each day using fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools\n' +
            '3. Inform user before/after each fetch\n' +
            '4. Build timesheet progressively, showing results after each day\n' +
            '5. Handle days with no activity by distributing work from adjacent days\n' +
            '6. Summarize each day to 255 characters\n\n' +
            'DEPENDENCY: This tool requires the Activity Collector MCP to be available. The LLM MUST verify that fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools are available. If NOT available, instruct the user to add the Activity Collector MCP to their configuration.\n\n' +
            'WHEN TO USE: Use this tool when user requests a monthly timesheet (e.g., "timesheet for November", "last month\'s timesheet").\n' +
            'For single day: use generate_daily_timesheet\n' +
            'For specific week: use generate_weekly_timesheet\n' +
            'For custom date range: use generate_date_range_timesheet\n\n' +
            'IMPORTANT: After calling this tool, the LLM MUST follow the returned instructions step-by-step.',
          inputSchema: {
            type: 'object',
            properties: {
              month: {
                type: 'string',
                description:
                  'Optional. Month in YYYY-MM format ONLY (e.g., "2025-11"). Defaults to current month.',
              },
              force_refresh: {
                type: 'boolean',
                description:
                  'Optional. If true, bypasses cache and fetches fresh data. Default: false.',
              },
            },
          },
        },
        {
          name: 'generate_weekly_timesheet',
          description:
            'ORCHESTRATION TOOL: Returns a detailed guide for building weekly timesheets day-by-day. This tool DOES NOT fetch data - it provides instructions for the LLM to:\n' +
            '1. Create a TODO list for all working days in the week\n' +
            '2. Fetch data for each day using fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools\n' +
            '3. Inform user before/after each fetch with what was found\n' +
            '4. Build timesheet progressively, showing results after each day\n' +
            '5. Handle days with no activity by distributing work from adjacent days\n' +
            '6. Summarize each day to 255 characters\n\n' +
            'DEPENDENCY: This tool requires the Activity Collector MCP to be available. The LLM MUST verify that fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools are available. If NOT available, instruct the user to add the Activity Collector MCP to their configuration.\n\n' +
            'WHEN TO USE: Use this tool when user requests a weekly timesheet (e.g., "this week\'s timesheet", "last week").\n' +
            'For single day: use generate_daily_timesheet\n' +
            'For full month: use generate_timesheet\n' +
            'For custom date range: use generate_date_range_timesheet\n\n' +
            'IMPORTANT: After calling this tool, the LLM MUST follow the returned instructions step-by-step.',
          inputSchema: {
            type: 'object',
            properties: {
              week: {
                type: 'string',
                description:
                  'Optional. Any date in the week in YYYY-MM-DD format ONLY (e.g., "2025-11-24"). Defaults to current week.',
              },
              force_refresh: {
                type: 'boolean',
                description:
                  'Optional. If true, bypasses cache and fetches fresh data. Default: false.',
              },
            },
          },
        },
        {
          name: 'generate_daily_timesheet',
          description:
            'ORCHESTRATION TOOL: Returns a detailed guide for building a single day timesheet. This tool DOES NOT fetch data - it provides instructions for the LLM to:\n' +
            '1. Check authentication status\n' +
            '2. Fetch data for the day using fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools\n' +
            '3. Inform user before/after each fetch\n' +
            '4. Build and present the timesheet\n' +
            '5. Summarize to 255 characters\n\n' +
            'DEPENDENCY: This tool requires the Activity Collector MCP to be available. The LLM MUST verify that fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools are available. If NOT available, instruct the user to add the Activity Collector MCP to their configuration.\n\n' +
            'WHEN TO USE: Use this tool when user requests a single day timesheet (e.g., "today\'s timesheet", "yesterday", "timesheet for Dec 1").\n' +
            'For multiple days: use generate_date_range_timesheet\n' +
            'For weekly timesheet: use generate_weekly_timesheet\n' +
            'For monthly timesheet: use generate_timesheet\n\n' +
            'IMPORTANT: After calling this tool, the LLM MUST follow the returned instructions step-by-step.',
          inputSchema: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description:
                  'Optional. Date in YYYY-MM-DD format ONLY (e.g., "2025-11-24"). Defaults to today.',
              },
              force_refresh: {
                type: 'boolean',
                description:
                  'Optional. If true, bypasses cache and fetches fresh data. Default: false.',
              },
            },
          },
        },
        {
          name: 'generate_date_range_timesheet',
          description:
            'ORCHESTRATION TOOL: Returns a detailed guide for building custom date range timesheets day-by-day. This tool DOES NOT fetch data - it provides instructions for the LLM to:\n' +
            '1. Create a TODO list for all working days in the date range\n' +
            '2. Fetch data for each day using fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools\n' +
            '3. Inform user before/after each fetch with specific counts (commits, MRs, events)\n' +
            '4. Build timesheet progressively, showing results after each day\n' +
            '5. Handle days with no activity by distributing work from adjacent days\n' +
            '6. Summarize each day to 255 characters\n\n' +
            'DEPENDENCY: This tool requires the Activity Collector MCP to be available. The LLM MUST verify that fetch_gitlab_activity, fetch_github_activity, and fetch_google_calendar_events tools are available. If NOT available, instruct the user to add the Activity Collector MCP to their configuration.\n\n' +
            'WHEN TO USE: Use this tool when user requests a custom date range (e.g., "last 3 days", "Dec 1-5", "timesheet from Nov 25 to Dec 2").\n' +
            'For single day: use generate_daily_timesheet\n' +
            'For standard week: use generate_weekly_timesheet\n' +
            'For full month: use generate_timesheet\n\n' +
            'IMPORTANT: After calling this tool, the LLM MUST follow the returned instructions step-by-step.',
          inputSchema: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description:
                  'Start date in YYYY-MM-DD format ONLY (e.g., "2025-11-01").',
              },
              end_date: {
                type: 'string',
                description:
                  'End date in YYYY-MM-DD format ONLY (e.g., "2025-11-30").',
              },
              force_refresh: {
                type: 'boolean',
                description:
                  'Optional. If true, bypasses cache and fetches fresh data. Default: false.',
              },
            },
            required: ['start_date', 'end_date'],
          },
        },
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'configure_psi':
            return await this.handleConfigurePSI(request.params.arguments);

          case 'get_psi_tasks':
            return await this.handleGetPSITasks(request.params.arguments);

          case 'submit_to_psi':
            return await this.handleSubmitToPSI(request.params.arguments);

          case 'inspect_psi_page':
            return await this.handleInspectPSIPage();

          case 'generate_timesheet':
            return await this.handleGenerateTimesheet(request.params.arguments);

          case 'generate_weekly_timesheet':
            return await this.handleGenerateWeeklyTimesheet(request.params.arguments);

          case 'generate_daily_timesheet':
            return await this.handleGenerateDailyTimesheet(request.params.arguments);

          case 'generate_date_range_timesheet':
            return await this.handleGenerateDateRangeTimesheet(request.params.arguments);

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleGenerateTimesheet(args: any) {
    // Parse month/year to show in instructions
    let year: number, month: number;
    if (args?.month) {
      const parsed = parseMonthYear(args.month);
      if (!parsed) {
        throw new Error(
          'Invalid month format. Use YYYY-MM format ONLY (e.g., "2025-11")'
        );
      }
      year = parsed.year;
      month = parsed.month;
    } else {
      const current = getCurrentMonth();
      year = current.year;
      month = current.month;
    }

    const monthName = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const forceRefresh = args?.force_refresh ?? false;

    // Get current date for reference
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDay}`;
    const currentDayName = formatDayOfWeek(now);

    return {
      content: [
        {
          type: 'text',
          text: `📋 **MONTHLY TIMESHEET ORCHESTRATION GUIDE**
**Month:** ${monthName} (${year}-${String(month).padStart(2, '0')})
**Today's Date:** ${currentDateStr} (${currentDayName})
**Force Refresh:** ${forceRefresh ? 'Yes (bypassing cache)' : 'No (using cache when available)'}

ℹ️ **Future Dates:** Working days include future dates for planning. Git activity tools will return empty results for future dates (no activity recorded yet), but calendar events can be fetched for future dates (meetings scheduled in advance).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **STEP-BY-STEP INSTRUCTIONS FOR LLM**

**STEP 0: CHECK AUTHENTICATION** ✅ MANDATORY
First, call check_authentication_status to see which services are configured.
ONLY use tools for configured services in subsequent steps.

**STEP 1: DETERMINE WORKING DAYS** ✅ MANDATORY
Calculate all working days for ${monthName}:
- Include all weekdays (Monday-Friday)
- Include FIRST Saturday of the month ONLY
- Exclude all Sundays
- Exclude all other Saturdays
- Include future dates (for planning purposes)

IMPORTANT: When calculating day names (Monday, Tuesday, etc.), you MUST calculate it correctly using the Today's Date provided above:
- NEVER guess or calculate day names manually
- Use the Today's Date provided above as reference (e.g., if today is 2025-12-03 (Wednesday), then 2025-12-02 is Tuesday, 2025-12-01 is Monday)
- OR use JavaScript: new Date(year, month - 1, day).getDay() where 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- Example: new Date(2025, 12-1, 1).getDay() returns 1, so December 1, 2025 is MONDAY (not Sunday)
- Example: new Date(2025, 12-1, 2).getDay() returns 2, so December 2, 2025 is TUESDAY

**STEP 1A: ASK ABOUT LEAVE DAYS** ✅ MANDATORY
Ask the user: "I found [NUMBER] working days in ${monthName}. Were you on leave on any of these days? If yes, please provide the dates (e.g., 2025-12-01, 2025-12-05) or type 'none'."

Wait for user response and:
- If user provides dates, remove those dates from the working days list
- If user says 'none' or similar, proceed with all working days
- Update the working days count after removing leave days

**STEP 2: ASK USER PREFERENCE** ✅ MANDATORY
Ask the user: "After excluding leave days, there are [NUMBER] working days to process. How would you like to see the results?
1. **Day-by-day** - I'll fetch and show each day's timesheet as I complete it (slower, but you see progress)
2. **All at once** - I'll fetch all data first, then show all timesheets together (faster, single result)

Please choose option 1 or 2."

Wait for user response before proceeding.

**STEP 3: CREATE TODO LIST** ✅ MANDATORY
Based on user choice, create TODO list:
- If user chose "day-by-day": Create one task per day: "Fetch and process timesheet for YYYY-MM-DD (DayName)"
- If user chose "all at once": Create bulk tasks: "Fetch all calendar events", "Fetch all GitLab activity", "Fetch all GitHub activity", "Build all timesheets"

**STEP 4A: IF USER CHOSE "DAY-BY-DAY"** ⚠️ Process one day at a time

For EACH working day (starting from day 1), follow this EXACT sequence:

   a) **Mark current day as in_progress** in TODO

   b) **Inform user BEFORE fetching**:
      "🔄 Fetching data for [DATE] ([DAY])..."

   c) **Fetch data SEQUENTIALLY** (one at a time, NOT in parallel):
      - First: fetch_google_calendar_events (if Google Calendar configured)
      - Then: fetch_gitlab_activity (if GitLab configured)
      - Then: fetch_github_activity (if GitHub configured)
      ${forceRefresh ? 'Use force_refresh: true for each call' : ''}

   d) **Inform user AFTER each fetch** with actual counts:
      "✅ [DATE]: Calendar: X events, GitLab: Y commits + Z MRs, GitHub: A commits + B PRs"

   e) **CHECK FOR ACTIVITY**:
      - IF day has Git activity (commits/MRs/PRs): GO TO STEP f
      - IF day has NO Git activity: GO TO next day

   f) **BUILD AND STREAM TIMESHEET FOR THIS DAY**:
      - Create timesheet entry, summarize to ≤ 255 characters
      - **IMMEDIATELY show this day's timesheet to user**

   g) **Mark day as completed** in TODO

   h) **REPEAT for next day**

**STEP 4B: IF USER CHOSE "ALL AT ONCE"** ⚠️ Fetch all data with date ranges

   a) **Fetch using DATE RANGES** (CRITICAL - USE start_date AND end_date):
      - Make ONLY 3 tool calls total in ONE message (one per service)
      - Call each service with start_date and end_date parameters:
        * fetch_google_calendar_events(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
        * fetch_gitlab_activity(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
        * fetch_github_activity(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
      - Example: If working days are Dec 1-5, make 3 calls with start_date="2025-12-01", end_date="2025-12-05"
      - DO NOT make individual calls for each date - use the date range parameters
      ${forceRefresh ? '- Use force_refresh: true for each call' : ''}

   b) **Wait for responses**:
      - After sending 3 fetch calls, wait for all responses to come back
      - Each response contains data for ALL dates in the range

   c) **Build ALL timesheets** ⚠️ CRITICAL - Handle days with no activity:
      - After all fetches complete, build timesheets for ALL working days (excluding leave days)
      - **IMPORTANT**: If a day has NO Git activity (0 commits, 0 MRs/PRs):
        * Look at adjacent days (previous day and next day)
        * Distribute/spread work from adjacent busy days to fill the gap
        * Create a reasonable summary based on surrounding context
        * Example: If Dec 3 has no activity but Dec 2 and Dec 4 have SDK work, assume Dec 3 also involved SDK work
      - Calendar events should still be mentioned if present
      - **CRITICAL - Include ticket/MR/issue numbers in summaries**:
        * ALWAYS include MR numbers (e.g., "MR #826", "!826")
        * ALWAYS include issue numbers if mentioned (e.g., "#1026", "issue #997")
        * Extract ticket numbers from commit messages and branch names (e.g., "1026-mdx-display" → ticket #1026)
        * Include ALL issues from the activity data (opened, commented, closed)
        * Example: "Fixed #1026: MDX display; merged MR #826; reviewed !823"
      - Summarize each day to ≤ 255 characters
      - **NEVER skip a working day** - every working day must have an entry in the final table

   d) **Present FINAL RESULTS in TABLE format** ⚠️ MANDATORY:
      - Create a markdown table with columns: Date | Day | Summary
      - Each summary MUST be ≤ 255 characters
      - **INCLUDE ALL WORKING DAYS** (excluding leave days), even if some had no direct Git activity
      - For days with no Git activity, use context from adjacent days to create a summary
      - DO NOT show detailed day-by-day breakdown unless user specifically asks for details
      - Example format:
        | Date | Day | Summary |
        |------|-----|---------|
        | 2025-12-01 | Monday | Fixed N+1 query & removed console logs; reviewed Chart HTML MR; attended Programme mgmt & SDK stand-up |
        | 2025-12-02 | Tuesday | Implemented MDX widget support with ToolCallCompleted, SendToAgentContext, PSEUDO_HUMAN; reviewed overlay fix |

**STEP 5: FINAL MESSAGE**
After presenting the table, tell user:
"✅ Completed timesheet for all working days in ${monthName}."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ **CRITICAL RULES:**
✓ ASK about leave days FIRST, then user preference (day-by-day or all at once)
✓ Check auth status - only use configured services
✓ Day-by-day mode: Process sequentially, show each day as completed
✓ All at once mode: Use date range parameters (start_date, end_date) to make only 3 calls total
✓ Present final results in markdown TABLE format (Date | Day | Summary)
✓ **INCLUDE ALL WORKING DAYS** in final table (excluding leave days)
✓ For days with NO Git activity: distribute/infer work from adjacent days
✓ **ALWAYS include ticket/MR/issue numbers** in summaries (extract from commits, branches, MRs, issues)
✓ Keep summaries ≤ 255 characters
✓ DO NOT show detailed breakdown unless user asks for details
✓ Future dates: Git tools return empty (no activity yet), but calendar can have events

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 **START NOW:** Begin with STEP 0 (Check authentication) and proceed sequentially.`,
        },
      ],
    };
  }

  private async handleGenerateWeeklyTimesheet(args: any) {
    // Parse week
    let weekStart: Date;
    if (args?.week) {
      const parsed = parseWeekInput(args.week);
      if (!parsed) {
        throw new Error(
          'Invalid week format. Use YYYY-MM-DD format ONLY (any date in the week, e.g., "2025-11-24")'
        );
      }
      weekStart = parsed;
    } else {
      weekStart = getCurrentWeek();
    }

    const weekRange = formatWeekRange(weekStart);
    const forceRefresh = args?.force_refresh ?? false;

    // Get current date for reference
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDay}`;
    const currentDayName = formatDayOfWeek(now);

    return {
      content: [
        {
          type: 'text',
          text: `📋 **WEEKLY TIMESHEET ORCHESTRATION GUIDE**
**Week:** ${weekRange}
**Today's Date:** ${currentDateStr} (${currentDayName})
**Force Refresh:** ${forceRefresh ? 'Yes (bypassing cache)' : 'No (using cache when available)'}

ℹ️ **Future Dates:** Working days include future dates for planning. Git activity tools will return empty results for future dates (no activity recorded yet), but calendar events can be fetched for future dates (meetings scheduled in advance).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **STEP-BY-STEP INSTRUCTIONS FOR LLM**

**STEP 0: CHECK AUTHENTICATION** ✅ MANDATORY
First, call check_authentication_status to see which services are configured.
ONLY use tools for configured services in subsequent steps.

**STEP 1: DETERMINE WORKING DAYS** ✅ MANDATORY
Calculate all working days for the week ${weekRange}:
- Include all weekdays (Monday-Friday) in this week
- Include FIRST Saturday of the month ONLY (if it falls in this week)
- Exclude all Sundays
- Exclude all other Saturdays
- Include future dates (for planning purposes)

IMPORTANT: When calculating day names (Monday, Tuesday, etc.), you MUST calculate it correctly using the Today's Date provided above:
- NEVER guess or calculate day names manually
- Use the Today's Date provided above as reference (e.g., if today is 2025-12-03 (Wednesday), then 2025-12-02 is Tuesday, 2025-12-01 is Monday)
- OR use JavaScript: new Date(year, month - 1, day).getDay() where 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- Example: new Date(2025, 12-1, 1).getDay() returns 1, so December 1, 2025 is MONDAY (not Sunday)
- Example: new Date(2025, 12-1, 2).getDay() returns 2, so December 2, 2025 is TUESDAY

**STEP 1A: ASK ABOUT LEAVE DAYS** ✅ MANDATORY
Ask the user: "I found [NUMBER] working days in ${weekRange}. Were you on leave on any of these days? If yes, please provide the dates (e.g., 2025-12-01, 2025-12-05) or type 'none'."

Wait for user response and:
- If user provides dates, remove those dates from the working days list
- If user says 'none' or similar, proceed with all working days
- Update the working days count after removing leave days

**STEP 2: ASK USER PREFERENCE** ✅ MANDATORY
Ask the user: "After excluding leave days, there are [NUMBER] working days to process. How would you like to see the results?
1. **Day-by-day** - I'll fetch and show each day's timesheet as I complete it (slower, but you see progress)
2. **All at once** - I'll fetch all data first, then show all timesheets together (faster, single result)

Please choose option 1 or 2."

Wait for user response before proceeding.

**STEP 3: CREATE TODO LIST** ✅ MANDATORY
Based on user choice, create TODO list:
- If user chose "day-by-day": Create one task per day: "Fetch and process timesheet for YYYY-MM-DD (DayName)"
- If user chose "all at once": Create bulk tasks: "Fetch all calendar events", "Fetch all GitLab activity", "Fetch all GitHub activity", "Build all timesheets"

**STEP 4A: IF USER CHOSE "DAY-BY-DAY"** ⚠️ Process one day at a time

For EACH working day (starting from day 1), follow this EXACT sequence:

   a) **Mark current day as in_progress** in TODO

   b) **Inform user BEFORE fetching**:
      "🔄 Fetching data for [DATE] ([DAY])..."

   c) **Fetch data SEQUENTIALLY** (one at a time, NOT in parallel):
      - First: fetch_google_calendar_events (if Google Calendar configured)
      - Then: fetch_gitlab_activity (if GitLab configured)
      - Then: fetch_github_activity (if GitHub configured)
      ${forceRefresh ? 'Use force_refresh: true for each call' : ''}

   d) **Inform user AFTER each fetch** with actual counts:
      "✅ [DATE]: Calendar: X events, GitLab: Y commits + Z MRs, GitHub: A commits + B PRs"

   e) **CHECK FOR ACTIVITY**:
      - IF day has Git activity (commits/MRs/PRs): GO TO STEP f
      - IF day has NO Git activity: GO TO next day

   f) **BUILD AND STREAM TIMESHEET FOR THIS DAY**:
      - Create timesheet entry, summarize to ≤ 255 characters
      - **IMMEDIATELY show this day's timesheet to user**

   g) **Mark day as completed** in TODO

   h) **REPEAT for next day**

**STEP 4B: IF USER CHOSE "ALL AT ONCE"** ⚠️ Fetch all data with date ranges

   a) **Fetch using DATE RANGES** (CRITICAL - USE start_date AND end_date):
      - Make ONLY 3 tool calls total in ONE message (one per service)
      - Call each service with start_date and end_date parameters:
        * fetch_google_calendar_events(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
        * fetch_gitlab_activity(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
        * fetch_github_activity(start_date="YYYY-MM-DD", end_date="YYYY-MM-DD")
      - Example: If working days are Dec 1-5, make 3 calls with start_date="2025-12-01", end_date="2025-12-05"
      - DO NOT make individual calls for each date - use the date range parameters
      ${forceRefresh ? '- Use force_refresh: true for each call' : ''}

   b) **Wait for responses**:
      - After sending 3 fetch calls, wait for all responses to come back
      - Each response contains data for ALL dates in the range

   c) **Build ALL timesheets** ⚠️ CRITICAL - Handle days with no activity:
      - After all fetches complete, build timesheets for ALL working days (excluding leave days)
      - **IMPORTANT**: If a day has NO Git activity (0 commits, 0 MRs/PRs):
        * Look at adjacent days (previous day and next day)
        * Distribute/spread work from adjacent busy days to fill the gap
        * Create a reasonable summary based on surrounding context
        * Example: If Dec 3 has no activity but Dec 2 and Dec 4 have SDK work, assume Dec 3 also involved SDK work
      - Calendar events should still be mentioned if present
      - **CRITICAL - Include ticket/MR/issue numbers in summaries**:
        * ALWAYS include MR numbers (e.g., "MR #826", "!826")
        * ALWAYS include issue numbers if mentioned (e.g., "#1026", "issue #997")
        * Extract ticket numbers from commit messages and branch names (e.g., "1026-mdx-display" → ticket #1026)
        * Include ALL issues from the activity data (opened, commented, closed)
        * Example: "Fixed #1026: MDX display; merged MR #826; reviewed !823"
      - Summarize each day to ≤ 255 characters
      - **NEVER skip a working day** - every working day must have an entry in the final table

   d) **Present FINAL RESULTS in TABLE format** ⚠️ MANDATORY:
      - Create a markdown table with columns: Date | Day | Summary
      - Each summary MUST be ≤ 255 characters
      - **INCLUDE ALL WORKING DAYS** (excluding leave days), even if some had no direct Git activity
      - For days with no Git activity, use context from adjacent days to create a summary
      - DO NOT show detailed day-by-day breakdown unless user specifically asks for details
      - Example format:
        | Date | Day | Summary |
        |------|-----|---------|
        | 2025-12-01 | Monday | Fixed N+1 query & removed console logs; reviewed Chart HTML MR; attended Programme mgmt & SDK stand-up |
        | 2025-12-02 | Tuesday | Implemented MDX widget support with ToolCallCompleted, SendToAgentContext, PSEUDO_HUMAN; reviewed overlay fix |

**STEP 5: FINAL MESSAGE**
After presenting the table, tell user:
"✅ Completed timesheet for all working days in ${weekRange}."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ **CRITICAL RULES:**
✓ ASK about leave days FIRST, then user preference (day-by-day or all at once)
✓ Check auth status - only use configured services
✓ Day-by-day mode: Process sequentially, show each day as completed
✓ All at once mode: Use date range parameters (start_date, end_date) to make only 3 calls total
✓ Present final results in markdown TABLE format (Date | Day | Summary)
✓ **INCLUDE ALL WORKING DAYS** in final table (excluding leave days)
✓ For days with NO Git activity: distribute/infer work from adjacent days
✓ **ALWAYS include ticket/MR/issue numbers** in summaries (extract from commits, branches, MRs, issues)
✓ Keep summaries ≤ 255 characters
✓ DO NOT show detailed breakdown unless user asks for details
✓ Future dates: Git tools return empty (no activity yet), but calendar can have events

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 **START NOW:** Begin with STEP 0 (Check authentication) and proceed sequentially.`,
        },
      ],
    };
  }

  private async handleGenerateDailyTimesheet(args: any) {
    // Parse date
    let date: Date;
    if (args?.date) {
      const parsed = parseDateInput(args.date);
      if (!parsed) {
        throw new Error(
          'Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-24")'
        );
      }
      date = parsed;
    } else {
      date = new Date();
    }

    // Format date in YYYY-MM-DD without timezone conversion
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const formattedDate = formatDate(date);
    const dayOfWeek = formatDayOfWeek(date);
    const forceRefresh = args?.force_refresh ?? false;

    // Get current date for reference
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDay}`;
    const currentDayName = formatDayOfWeek(now);

    return {
      content: [
        {
          type: 'text',
          text: `📋 **DAILY TIMESHEET ORCHESTRATION GUIDE**
**Date:** ${formattedDate} (${dayOfWeek})
**ISO Date:** ${dateStr}
**Today's Date:** ${currentDateStr} (${currentDayName})
**Force Refresh:** ${forceRefresh ? 'Yes (bypassing cache)' : 'No (using cache when available)'}

🎯 **STEP-BY-STEP INSTRUCTIONS FOR LLM**

**STEP 0: CHECK AUTHENTICATION** ✅ MANDATORY
First, call check_authentication_status to see which services are configured.
ONLY use tools for configured services in subsequent steps.

**STEP 1: INFORM USER**
Tell the user: "🔄 Fetching data for ${formattedDate} (${dayOfWeek})..."

**STEP 2: FETCH DATA SEQUENTIALLY** ⚠️ CRITICAL: ONE AT A TIME
Fetch data SEQUENTIALLY (one at a time, NOT in parallel):
   a) First: fetch_google_calendar_events with date "${dateStr}" (if Google Calendar configured)
   b) Then: fetch_gitlab_activity with date "${dateStr}" (if GitLab configured)
   c) Then: fetch_github_activity with date "${dateStr}" (if GitHub configured)

After EACH fetch, inform user what was found (e.g., "Found 3 commits, 1 MR").

**STEP 3: BUILD TIMESHEET**
Combine all the activity data into a single description:
   - Include calendar event titles
   - Include commit messages with story numbers
   - Include MR/PR actions and numbers
   - Intelligently summarize to fit within 255 characters
   - Use abbreviations (e.g., "impl" for "implement", "docs" for "documentation")
   - Remove redundant phrases

**STEP 4: PRESENT FINAL TIMESHEET**
Present in this exact format:
\`\`\`
# Daily Timesheet
**${formattedDate} (${dayOfWeek})**

[Your 255-character description here]

*Character count: X/255*
\`\`\`

⚠️ **CRITICAL RULES:**
✓ Check auth status FIRST - only use configured services
✓ Fetch tools SEQUENTIALLY (calendar first, then GitLab, then GitHub)
✓ Inform user after each fetch
✓ Keep final description ≤ 255 characters
✓ Include meaningful information (meeting names, story numbers, actions)

🚀 **START NOW:** Begin with STEP 0 (Check authentication).`,
        },
      ],
    };
  }

  private async handleGenerateDateRangeTimesheet(args: any) {
    // Parse dates
    if (!args?.start_date || !args?.end_date) {
      throw new Error('Both start_date and end_date are required');
    }

    const startDate = parseDateInput(args.start_date);
    const endDate = parseDateInput(args.end_date);

    if (!startDate || !endDate) {
      throw new Error(
        'Invalid date format. Use YYYY-MM-DD format ONLY (e.g., "2025-11-01")'
      );
    }

    if (startDate > endDate) {
      throw new Error('start_date must be before or equal to end_date');
    }

    const forceRefresh = args?.force_refresh ?? false;

    const dateRange = `${formatDate(startDate)} to ${formatDate(endDate)}`;

    // Get current date for reference
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDay}`;
    const currentDayName = formatDayOfWeek(now);

    return {
      content: [
        {
          type: 'text',
          text: `📋 **DATE RANGE TIMESHEET ORCHESTRATION GUIDE**
**Date Range:** ${dateRange}
**Start Date:** ${formatDate(startDate)}
**End Date:** ${formatDate(endDate)}
**Today's Date:** ${currentDateStr} (${currentDayName})
**Force Refresh:** ${forceRefresh ? 'Yes (bypassing cache)' : 'No (using cache when available)'}

ℹ️ **Future Dates:** Working days include future dates for planning. Git activity tools will return empty results for future dates (no activity recorded yet), but calendar events can be fetched for future dates (meetings scheduled in advance).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 **STEP-BY-STEP INSTRUCTIONS FOR LLM**

**STEP 0: CHECK AUTHENTICATION** ✅ MANDATORY
First, call check_authentication_status to see which services are configured.
ONLY use tools for configured services in subsequent steps.

**STEP 1: DETERMINE WORKING DAYS** ✅ MANDATORY
Calculate all working days from ${formatDate(startDate)} to ${formatDate(endDate)}:
- Include all weekdays (Monday-Friday)
- Include FIRST Saturday of each month ONLY
- Exclude all Sundays
- Exclude all other Saturdays
- Include future dates (for planning purposes)

IMPORTANT: When calculating day names (Monday, Tuesday, etc.), you MUST calculate it correctly using the Today's Date provided above:
- NEVER guess or calculate day names manually
- Use the Today's Date provided above as reference (e.g., if today is 2025-12-03 (Wednesday), then 2025-12-02 is Tuesday, 2025-12-01 is Monday)
- OR use JavaScript: new Date(year, month - 1, day).getDay() where 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
- Example: new Date(2025, 12-1, 1).getDay() returns 1, so December 1, 2025 is MONDAY (not Sunday)
- Example: new Date(2025, 12-1, 2).getDay() returns 2, so December 2, 2025 is TUESDAY

**STEP 1A: ASK ABOUT LEAVE DAYS** ✅ MANDATORY
Ask the user: "I found [NUMBER] working days from ${dateRange}. Were you on leave on any of these days? If yes, please provide the dates (e.g., 2025-12-01, 2025-12-05) or type 'none'."

Wait for user response and:
- If user provides dates, remove those dates from the working days list
- If user says 'none' or similar, proceed with all working days
- Update the working days count after removing leave days

**STEP 2: ASK USER PREFERENCE** ✅ MANDATORY
Ask the user: "After excluding leave days, there are [NUMBER] working days to process. How would you like to see the results?
1. **Day-by-day** - I'll fetch and show each day's timesheet as I complete it (slower, but you see progress)
2. **All at once** - I'll fetch all data first, then show all timesheets together (faster, single result)

Please choose option 1 or 2."

Wait for user response before proceeding.

**STEP 3: CREATE TODO LIST** ✅ MANDATORY
Based on user choice, create TODO list:
- If user chose "day-by-day": Create one task per day: "Fetch and process timesheet for YYYY-MM-DD (DayName)"
- If user chose "all at once": Create bulk tasks: "Fetch all calendar events", "Fetch all GitLab activity", "Fetch all GitHub activity", "Build all timesheets"

**STEP 4A: IF USER CHOSE "DAY-BY-DAY"** ⚠️ Process one day at a time

For EACH working day (starting from day 1), follow this EXACT sequence:

   a) **Mark current day as in_progress** in TODO

   b) **Inform user BEFORE fetching**:
      "🔄 Fetching data for [DATE] ([DAY])..."

   c) **Fetch data SEQUENTIALLY** (one at a time, NOT in parallel):
      - First: fetch_google_calendar_events (if Google Calendar configured)
      - Then: fetch_gitlab_activity (if GitLab configured)
      - Then: fetch_github_activity (if GitHub configured)
      ${forceRefresh ? 'Use force_refresh: true for each call' : ''}

   d) **Inform user AFTER each fetch** with actual counts:
      "✅ [DATE]: Calendar: X events, GitLab: Y commits + Z MRs, GitHub: A commits + B PRs"

   e) **CHECK FOR ACTIVITY**:
      - IF day has Git activity (commits/MRs/PRs): GO TO STEP f
      - IF day has NO Git activity: GO TO next day

   f) **BUILD AND STREAM TIMESHEET FOR THIS DAY**:
      - Create timesheet entry, summarize to ≤ 255 characters
      - **IMMEDIATELY show this day's timesheet to user**

   g) **Mark day as completed** in TODO

   h) **REPEAT for next day**

**STEP 4B: IF USER CHOSE "ALL AT ONCE"** ⚠️ Fetch all data with date ranges

   a) **Fetch using DATE RANGES** (CRITICAL - USE start_date AND end_date):
      - Make ONLY ONE call per service using date range parameters
      - Call each configured service with start_date="${dateRange.split(' to ')[0]}" and end_date="${dateRange.split(' to ')[1]}":
        * fetch_google_calendar_events(start_date="${dateRange.split(' to ')[0]}", end_date="${dateRange.split(' to ')[1]}")${forceRefresh ? ', force_refresh: true' : ''}
        * fetch_gitlab_activity(start_date="${dateRange.split(' to ')[0]}", end_date="${dateRange.split(' to ')[1]}")${forceRefresh ? ', force_refresh: true' : ''}
        * fetch_github_activity(start_date="${dateRange.split(' to ')[0]}", end_date="${dateRange.split(' to ')[1]}")${forceRefresh ? ', force_refresh: true' : ''}
      - Make all calls in a SINGLE message (parallel execution)
      - Example: For 5 working days, make only 3 calls total (NOT 15)
      - DO NOT make individual calls for each date - always use start_date and end_date parameters

   b) **Wait for ALL responses**:
      - After sending all fetch calls, wait for all responses to come back
      - Each response will contain aggregated data for all dates in the range

   c) **Build ALL timesheets** ⚠️ CRITICAL - Handle days with no activity:
      - After all fetches complete, build timesheets for ALL working days (excluding leave days)
      - **IMPORTANT**: If a day has NO Git activity (0 commits, 0 MRs/PRs):
        * Look at adjacent days (previous day and next day)
        * Distribute/spread work from adjacent busy days to fill the gap
        * Create a reasonable summary based on surrounding context
        * Example: If Dec 3 has no activity but Dec 2 and Dec 4 have SDK work, assume Dec 3 also involved SDK work
      - Calendar events should still be mentioned if present
      - **CRITICAL - Include ticket/MR/issue numbers in summaries**:
        * ALWAYS include MR numbers (e.g., "MR #826", "!826")
        * ALWAYS include issue numbers if mentioned (e.g., "#1026", "issue #997")
        * Extract ticket numbers from commit messages and branch names (e.g., "1026-mdx-display" → ticket #1026)
        * Include ALL issues from the activity data (opened, commented, closed)
        * Example: "Fixed #1026: MDX display; merged MR #826; reviewed !823"
      - Summarize each day to ≤ 255 characters
      - **NEVER skip a working day** - every working day must have an entry in the final table

   d) **Present FINAL RESULTS in TABLE format** ⚠️ MANDATORY:
      - Create a markdown table with columns: Date | Day | Summary
      - Each summary MUST be ≤ 255 characters
      - **INCLUDE ALL WORKING DAYS** (excluding leave days), even if some had no direct Git activity
      - For days with no Git activity, use context from adjacent days to create a summary
      - DO NOT show detailed day-by-day breakdown unless user specifically asks for details
      - Example format:
        | Date | Day | Summary |
        |------|-----|---------|
        | 2025-12-01 | Monday | Fixed N+1 query & removed console logs; reviewed Chart HTML MR; attended Programme mgmt & SDK stand-up |
        | 2025-12-02 | Tuesday | Implemented MDX widget support with ToolCallCompleted, SendToAgentContext, PSEUDO_HUMAN; reviewed overlay fix |

**STEP 5: FINAL MESSAGE**
After presenting the table, tell user:
"✅ Completed timesheet for all working days from ${dateRange}."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ **CRITICAL RULES:**
✓ ASK about leave days FIRST, then user preference (day-by-day or all at once)
✓ Check auth status - only use configured services
✓ Day-by-day mode: Process sequentially, show each day as completed
✓ All at once mode: Use date range parameters (start_date, end_date) to make only 3 calls total
✓ Present final results in markdown TABLE format (Date | Day | Summary)
✓ **INCLUDE ALL WORKING DAYS** in final table (excluding leave days)
✓ For days with NO Git activity: distribute/infer work from adjacent days
✓ **ALWAYS include ticket/MR/issue numbers** in summaries (extract from commits, branches, MRs, issues)
✓ Keep summaries ≤ 255 characters
✓ DO NOT show detailed breakdown unless user asks for details
✓ Future dates: Git tools return empty (no activity yet), but calendar can have events

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 **START NOW:** Begin with STEP 0 (Check authentication) and proceed sequentially.`,
        },
      ],
    };
  }

  private async handleConfigurePSI(args: any) {
    await this.tokenStorage.load();
    const config = await this.loadConfig();

    const username = args.username;
    const password = args.password;
    const url = args.url || 'https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx';

    // Save PSI credentials to token storage
    await this.tokenStorage.setPSICredentials(username, password);

    // Update config with URL
    if (!config.psi) {
      config.psi = { url };
    } else {
      config.psi.url = url;
    }
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: `PSI configured successfully!\n\nURL: ${url}\nUsername: ${username}\n\nYou can now use the 'submit_to_psi' tool to submit timesheet entries.`,
        },
      ],
    };
  }

  private async handleGetPSITasks(args: any) {
    await this.tokenStorage.load();
    const config = await this.loadConfig();

    const psiCreds = this.tokenStorage.getPSICredentials();
    if (!psiCreds) {
      throw new Error('PSI not configured. Please use configure_psi tool first.');
    }

    const baseUrl = config.psi?.url || 'https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx';

    // Construct URL with embedded credentials: https://username:password@domain.com/path
    const urlObj = new URL(baseUrl);
    urlObj.username = psiCreds.username;
    urlObj.password = psiCreds.password;
    const url = urlObj.toString();

    const { PSITimesheetIntegration } = await import('./integrations/psi.js');
    const psiIntegration = new PSITimesheetIntegration(url, psiCreds.username, psiCreds.password);

    try {
      const result = await psiIntegration.getTasks(args.date);

      if (result.success && result.tasks) {
        // Extract the hierarchical view for presentation
        const instructions = `
INSTRUCTIONS FOR LLM:

You have successfully fetched the available PSI tasks for ${args.date}.

YOUR NEXT STEPS:
1. Present the hierarchical task tree to the user EXACTLY as shown below
2. Explain that:
   - [DISABLED] tasks are parent categories that cannot be selected
   - [ENABLED] tasks can be selected for timesheet submission
   - Each task has an index number in brackets (e.g., [3])
3. Ask the user: "Which task would you like to use? Please provide the index number."

HIERARCHICAL TASK TREE:
\`\`\`
${result.tasks.hierarchicalView}
\`\`\`

EXAMPLE USER RESPONSE:
"I want to use task 3" or "Use index 3"

Once the user provides a task index, use the submit_to_psi tool with:
- date: "${args.date}"
- taskIndex: <user's selected index>
- description: <timesheet description from generated timesheet>
- hours: "8h" (or as specified)
`;

        return {
          content: [
            {
              type: 'text',
              text: instructions,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get tasks: ${result.message}`,
            },
          ],
        };
      }
    } finally {
      await psiIntegration.close();
    }
  }

  private async handleSubmitToPSI(args: any) {
    await this.tokenStorage.load();
    const config = await this.loadConfig();

    const psiCreds = this.tokenStorage.getPSICredentials();
    if (!psiCreds) {
      throw new Error('PSI not configured. Please use configure_psi tool first.');
    }

    const baseUrl = config.psi?.url || 'https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx';

    // Construct URL with embedded credentials: https://username:password@domain.com/path
    const urlObj = new URL(baseUrl);
    urlObj.username = psiCreds.username;
    urlObj.password = psiCreds.password;
    const url = urlObj.toString();

    const { PSITimesheetIntegration } = await import('./integrations/psi.js');
    const psiIntegration = new PSITimesheetIntegration(url, psiCreds.username, psiCreds.password);

    try {
      const result = await psiIntegration.submitTimesheet(
        args.date,
        args.taskIndex,
        args.description,
        args.hours || '8h'
      );

      if (result.success) {
        return {
          content: [
            {
              type: 'text',
              text: result.message,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Submission failed: ${result.message}`,
            },
          ],
        };
      }
    } finally {
      await psiIntegration.close();
    }
  }

  private async handleInspectPSIPage() {
    await this.tokenStorage.load();
    const config = await this.loadConfig();

    const psiCreds = this.tokenStorage.getPSICredentials();
    if (!psiCreds) {
      throw new Error('PSI not configured. Please use configure_psi tool first.');
    }

    const baseUrl = config.psi?.url || 'https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx';

    // Construct URL with embedded credentials: https://username:password@domain.com/path
    const urlObj = new URL(baseUrl);
    urlObj.username = psiCreds.username;
    urlObj.password = psiCreds.password;
    const url = urlObj.toString();

    const { PSITimesheetIntegration } = await import('./integrations/psi.js');
    const psiIntegration = new PSITimesheetIntegration(url, psiCreds.username, psiCreds.password);

    try {
      const pageStructure = await psiIntegration.inspectPageStructure();

      return {
        content: [
          {
            type: 'text',
            text: `PSI Page Structure:\n\n\`\`\`json\n${pageStructure}\n\`\`\`\n\nUse this information to customize the PSI integration if the default selectors don't work.`,
          },
        ],
      };
    } finally {
      await psiIntegration.close();
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Timesheet Assistant MCP server running on stdio');
  }
}

const server = new TimesheetAssistantMCPServer();
server.run().catch(console.error);
