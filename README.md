# Timesheet Assistant MCP

An MCP (Model Context Protocol) server for generating timesheets and submitting them to PSI Project Server (SharePoint-based timesheet systems).

## Features

- **Timesheet Generation**: Generate daily, weekly, monthly, or custom date range timesheets
- **PSI Integration**: Automated submission to PSI Project Server
- **Activity Data Integration**: Works with [Activity Collector MCP](https://github.com/srdmathur/activity-collector-mcp) for data fetching
- **Smart Summarization**: Automatically summarizes work descriptions to 255 characters
- **Browser Automation**: Uses Puppeteer for SharePoint authentication and form filling
- **Task Management**: Hierarchical task tree navigation for PSI

## Prerequisites

**⚠️ Important**: This MCP requires [Activity Collector MCP](https://github.com/srdmathur/activity-collector-mcp) to fetch activity data from GitLab, GitHub, and Calendar services.

## Installation

### Via npx (Recommended)

```bash
npx timesheet-assistant-mcp
```

### Via npm

```bash
npm install -g timesheet-assistant-mcp
```

### From Source

```bash
git clone https://github.com/sharadmathuratthepsi/timesheet-mcp.git
cd timesheet-mcp
npm install
npm run build
```

## Configuration

### For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "activity-collector": {
      "command": "npx",
      "args": ["activity-collector-mcp"]
    },
    "timesheet-assistant": {
      "command": "npx",
      "args": ["timesheet-assistant-mcp"]
    }
  }
}
```

### For Claude Code (VS Code)

Add to `~/Library/Application Support/Code/User/mcp.json`:

```json
{
  "servers": {
    "activity-collector": {
      "type": "stdio",
      "command": "npx",
      "args": ["activity-collector-mcp"]
    },
    "timesheet-assistant": {
      "type": "stdio",
      "command": "npx",
      "args": ["timesheet-assistant-mcp"]
    }
  }
}
```

### Configuration File

Create `~/.timesheet-assistant-mcp-config.json`:

```json
{
  "psi": {
    "url": "https://projectserver.thepsi.com/PWA/_layouts/15/pwa/Timesheet/MyTSSummary.aspx"
  }
}
```

## Usage

### First Time Setup

1. **Configure PSI credentials**:
   ```
   Configure PSI with username: YOUR_USERNAME and password: YOUR_PASSWORD
   ```

### Generating Timesheets

- **Daily**: `Generate timesheet for today`
- **Weekly**: `Generate timesheet for this week`
- **Monthly**: `Generate timesheet for November 2024`
- **Date Range**: `Generate timesheet from 2024-12-01 to 2024-12-07`

### Submitting to PSI

1. **Generate timesheet** (using Activity Collector MCP)
2. **Get PSI tasks** (call once, reuse for all days):
   ```
   Get PSI tasks for 2024-12-05
   ```
3. **Select task** from the hierarchical tree
4. **Submit timesheet**:
   ```
   Submit to PSI for 2024-12-05 with task index 3 and description "..."
   ```

## Available Tools (8)

### Timesheet Generation (4 tools)
- `generate_timesheet` - Generate monthly timesheet
- `generate_weekly_timesheet` - Generate weekly timesheet
- `generate_daily_timesheet` - Generate single day timesheet
- `generate_date_range_timesheet` - Generate custom date range timesheet

**Note**: These tools orchestrate the Activity Collector MCP to fetch data.

### PSI Integration (4 tools)
- `configure_psi` - Configure PSI credentials
- `get_psi_tasks` - Get available tasks from PSI (call once per timesheet period)
- `submit_to_psi` - Submit timesheet entry to PSI
- `inspect_psi_page` - Debug PSI page structure

## How It Works

### Timesheet Generation Flow
1. LLM calls timesheet generation tool (e.g., `generate_weekly_timesheet`)
2. Tool returns instructions for fetching data from Activity Collector MCP
3. LLM uses Activity Collector tools (`fetch_gitlab_activity`, `fetch_github_activity`, `fetch_google_calendar_events`)
4. LLM builds and formats the timesheet

### PSI Submission Flow
1. Call `get_psi_tasks` **once** to get available tasks
2. User selects a task by index
3. Call `submit_to_psi` for each day (reusing same task index)
4. Browser automation fills SharePoint form and saves

## PSI Integration Details

- Uses Puppeteer for browser automation
- Supports HTTP Basic Auth for SharePoint
- Handles lazy-loaded accordion trees for task selection
- Smart grid cell detection for SharePoint JSGrid
- Automatic form filling with MouseEvent simulation

## Security

- PSI credentials stored in `~/.timesheet-assistant-mcp-tokens.json` with restricted permissions (600)
- Browser runs in non-headless mode by default (can see what's happening)
- All data remains local

## Troubleshooting

### Activity Collector Not Available
```
Error: fetch_gitlab_activity tool not found
```
**Solution**: Install and configure [Activity Collector MCP](https://github.com/srdmathur/activity-collector-mcp)

### PSI Submission Fails
```
Error: Could not find hours cell
```
**Solution**: Run `inspect_psi_page` to check PSI page structure

### Browser Crashes
**Solution**: Ensure Puppeteer dependencies are installed:
```bash
npm install puppeteer
```

## License

MIT

## Contributing

Issues and pull requests welcome!

## Author

Sharad Mathur (sharad.mathur@thepsi.com)

## Related Projects

- [Activity Collector MCP](https://github.com/srdmathur/activity-collector-mcp) - Required companion MCP for data fetching
