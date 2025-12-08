import { DayActivity, TimesheetEntry, GitLabActivity, CalendarEvent } from '../types/index.js';
import { formatDate, formatDayOfWeek } from './dateUtils.js';

export class TimesheetGenerator {
  generateTimesheet(activities: DayActivity[]): TimesheetEntry[] {
    return activities.map(activity => {
      const description = this.generateDayDescription(activity);
      const charCount = this.countCharacters(description);

      return {
        date: formatDate(activity.date),
        dayOfWeek: formatDayOfWeek(activity.date),
        description,
        wordCount: charCount, // Now contains actual character count without truncation
      };
    });
  }

  private generateDayDescription(activity: DayActivity): string {
    const parts: string[] = [];

    // Add meetings first
    if (activity.meetings.length > 0) {
      parts.push(this.formatMeetings(activity.meetings));
    }

    // Add GitLab activities
    const gitlabDesc = this.formatGitLabActivity(activity.gitlabActivity);
    if (gitlabDesc) {
      parts.push(gitlabDesc);
    }

    let fullDescription = parts.join(' ');

    // Return full description - LLM will handle summarization to 255 characters
    return fullDescription;
  }

  private formatMeetings(meetings: CalendarEvent[]): string {
    if (meetings.length === 0) return '';

    const meetingTitles = meetings.map(m => m.title);

    if (meetingTitles.length === 1) {
      return `Attended ${meetingTitles[0]}.`;
    } else if (meetingTitles.length === 2) {
      return `Attended ${meetingTitles[0]} and ${meetingTitles[1]}.`;
    } else {
      const lastMeeting = meetingTitles.pop();
      return `Attended ${meetingTitles.join(', ')}, and ${lastMeeting}.`;
    }
  }

  private formatGitLabActivity(activity: GitLabActivity): string {
    const parts: string[] = [];

    // Group commits by project
    const commitsByProject = this.groupCommitsByProject(activity.commits);
    if (Object.keys(commitsByProject).length > 0) {
      const commitDesc = this.formatCommits(commitsByProject);
      if (commitDesc) parts.push(commitDesc);
    }

    // Format merge requests
    if (activity.mergeRequests.length > 0) {
      const mrDesc = this.formatMergeRequests(activity.mergeRequests);
      if (mrDesc) parts.push(mrDesc);
    }

    // Format issues
    if (activity.issues.length > 0) {
      const issueDesc = this.formatIssues(activity.issues);
      if (issueDesc) parts.push(issueDesc);
    }

    return parts.join(' ');
  }

  private groupCommitsByProject(
    commits: GitLabActivity['commits']
  ): Record<string, Array<{ message: string; branch: string }>> {
    const grouped: Record<string, Array<{ message: string; branch: string }>> = {};

    for (const commit of commits) {
      if (!grouped[commit.project]) {
        grouped[commit.project] = [];
      }
      grouped[commit.project].push({
        message: commit.message,
        branch: commit.branch,
      });
    }

    return grouped;
  }

  private formatCommits(
    commitsByProject: Record<string, Array<{ message: string; branch: string }>>
  ): string {
    const projectDescriptions: string[] = [];

    for (const [project, commits] of Object.entries(commitsByProject)) {
      if (commits.length === 1) {
        projectDescriptions.push(`committed "${commits[0].message}" to ${project}`);
      } else {
        const messages = commits.map(c => `"${c.message}"`).join(', ');
        projectDescriptions.push(`made ${commits.length} commits to ${project}: ${messages}`);
      }
    }

    if (projectDescriptions.length === 0) return '';

    return 'Worked on ' + projectDescriptions.join('; ') + '.';
  }

  private formatMergeRequests(mergeRequests: GitLabActivity['mergeRequests']): string {
    const grouped = {
      created: mergeRequests.filter(mr => mr.action === 'created'),
      reviewed: mergeRequests.filter(mr => mr.action === 'reviewed'),
      approved: mergeRequests.filter(mr => mr.action === 'approved'),
      commented: mergeRequests.filter(mr => mr.action === 'commented'),
    };

    const parts: string[] = [];

    if (grouped.created.length > 0) {
      const titles = grouped.created.map(mr => `"${mr.title}" in ${mr.project}`);
      parts.push(`Created MR${grouped.created.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    if (grouped.reviewed.length > 0) {
      const titles = grouped.reviewed.map(mr => `"${mr.title}" in ${mr.project}`);
      parts.push(`Reviewed MR${grouped.reviewed.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    if (grouped.approved.length > 0) {
      const titles = grouped.approved.map(mr => `"${mr.title}" in ${mr.project}`);
      parts.push(`Approved MR${grouped.approved.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    if (grouped.commented.length > 0) {
      const titles = grouped.commented.map(mr => `"${mr.title}" in ${mr.project}`);
      parts.push(`Commented on MR${grouped.commented.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    return parts.join('. ') + (parts.length > 0 ? '.' : '');
  }

  private formatIssues(issues: GitLabActivity['issues']): string {
    const parts: string[] = [];

    const commented = issues.filter(i => i.action === 'commented');
    const statusChanged = issues.filter(i => i.action === 'status_changed');
    const assigned = issues.filter(i => i.action === 'assigned');

    if (commented.length > 0) {
      const titles = commented.map(i => `"${i.title}" in ${i.project}`);
      parts.push(`Commented on issue${commented.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    if (statusChanged.length > 0) {
      const titles = statusChanged.map(i => `"${i.title}" in ${i.project}${i.details ? ` (${i.details})` : ''}`);
      parts.push(`Updated issue${statusChanged.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    if (assigned.length > 0) {
      const titles = assigned.map(i => `"${i.title}" in ${i.project}`);
      parts.push(`Assigned to issue${assigned.length > 1 ? 's' : ''}: ${titles.join(', ')}`);
    }

    return parts.join('. ') + (parts.length > 0 ? '.' : '');
  }

  private countCharacters(text: string): number {
    return text.length;
  }

  formatTimesheetOutput(entries: TimesheetEntry[]): string {
    let output = '# Monthly Timesheet (Raw Data)\n\n';

    for (const entry of entries) {
      output += `## ${entry.date} (${entry.dayOfWeek})\n`;
      output += `${entry.description}\n`;
      output += `*Current length: ${entry.wordCount} characters*\n\n`;
    }

    return output;
  }
}
