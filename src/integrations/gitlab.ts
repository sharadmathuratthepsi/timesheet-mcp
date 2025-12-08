import { Gitlab } from '@gitbeaker/rest';
import { GitLabActivity } from '../types/index.js';

export class GitLabIntegration {
  private client: InstanceType<typeof Gitlab> | null = null;
  private userId: number | null = null;
  public debugInfo: any = null; // For debugging API responses

  async initialize(token: string, gitlabUrl: string = 'https://gitlab.com'): Promise<void> {
    this.client = new Gitlab({
      token,
      host: gitlabUrl,
    });

    // Get current user ID
    const user = await this.client.Users.showCurrentUser();
    this.userId = user.id;
  }

  async getActivityForDate(dateStr: string): Promise<GitLabActivity> {
    if (!this.client || !this.userId) {
      throw new Error('GitLab client not initialized');
    }

    // Validate YYYY-MM-DD format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Date must be in YYYY-MM-DD format (e.g., "2025-12-01")');
    }

    // Parse date to create Date object for activity
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    const activity: GitLabActivity = {
      date,
      commits: [],
      mergeRequests: [],
      issues: [],
    };

    try {
      // Calculate week before date for API 'after' parameter
      const weekBeforeDate = new Date(year, month - 1, day);
      weekBeforeDate.setDate(weekBeforeDate.getDate() - 7);
      const wy = weekBeforeDate.getFullYear();
      const wm = String(weekBeforeDate.getMonth() + 1).padStart(2, '0');
      const wd = String(weekBeforeDate.getDate()).padStart(2, '0');
      const afterDate = `${wy}-${wm}-${wd}`;

      // Fetch all pages of events
      let page = 1;
      const perPage = 100; // Max per page
      let hasMorePages = true;

      while (hasMorePages) {
        const events = await this.client.Events.all({
          after: afterDate,
          page,
          perPage,
        });

        // Store complete RAW API response
        if (page === 1) {
          this.debugInfo = {
            dateRange: { after: afterDate },
            targetDay: dateStr,
            eventsReturned: events.length,
            rawApiResponse: events // ALL events, complete raw response
          };
        }

        // If we get less than perPage, this is the last page
        if (events.length < perPage) {
          hasMorePages = false;
        }

        // Process events
        for (const event of events) {
          // Only process events by the current user
          if (event.author_id !== this.userId) continue;

          // Filter by date - extract YYYY-MM-DD from event timestamp
          const eventDateStr = (event.created_at as string).split('T')[0];
          if (eventDateStr !== dateStr) continue;

          // Get project name (cached)
          const projectName = event.project_id && typeof event.project_id === 'number'
            ? await this.getProjectName(event.project_id)
            : 'Unknown';

          // Process based on action type
          this.processEvent(event, projectName, activity);
        }

        page++;
      }

    } catch (error) {
      console.error('Error fetching GitLab activity:', error);
    }

    return activity;
  }

  private processEvent(event: any, projectName: string, activity: GitLabActivity): void {
    switch (event.action_name) {
      case 'pushed to':
      case 'pushed new':
        if (event.push_data && typeof event.push_data === 'object') {
          const pushData = event.push_data as any;
          activity.commits.push({
            message: String(pushData.commit_title || 'Commit'),
            project: projectName,
            branch: String(pushData.ref || 'unknown'),
          });
        }
        break;

      case 'opened':
        if (event.target_type === 'MergeRequest') {
          activity.mergeRequests.push({
            action: 'created',
            title: String(event.target_title || 'MR'),
            project: projectName,
            id: event.target_iid,
          });
        } else if (event.target_type === 'Issue') {
          activity.issues.push({
            action: 'opened',
            title: String(event.target_title || 'Issue'),
            project: projectName,
            id: event.target_iid,
          });
        }
        break;

      case 'commented on':
        // For comments, check the note.noteable_type instead of target_type
        // target_type can be "Note" or "DiffNote" which doesn't tell us what was commented on
        if (event.note && typeof event.note === 'object') {
          const noteableType = (event.note as any).noteable_type;
          const noteableIid = (event.note as any).noteable_iid;

          if (noteableType === 'MergeRequest') {
            activity.mergeRequests.push({
              action: 'commented',
              title: String(event.target_title || 'MR'),
              project: projectName,
              id: noteableIid || event.target_iid,
            });
          } else if (noteableType === 'Issue') {
            activity.issues.push({
              action: 'commented',
              title: String(event.target_title || 'Issue'),
              project: projectName,
              id: noteableIid || event.target_iid,
            });
          }
        } else {
          // Fallback to old logic if note object is not available
          if (event.target_type === 'MergeRequest') {
            activity.mergeRequests.push({
              action: 'commented',
              title: String(event.target_title || 'MR'),
              project: projectName,
              id: event.target_iid,
            });
          } else if (event.target_type === 'Issue') {
            activity.issues.push({
              action: 'commented',
              title: String(event.target_title || 'Issue'),
              project: projectName,
              id: event.target_iid,
            });
          }
        }
        break;

      case 'accepted':
      case 'approved':
        if (event.target_type === 'MergeRequest') {
          activity.mergeRequests.push({
            action: 'approved',
            title: String(event.target_title || 'MR'),
            project: projectName,
            id: event.target_iid,
          });
        }
        break;

      case 'closed':
        if (event.target_type === 'MergeRequest') {
          activity.mergeRequests.push({
            action: 'closed',
            title: String(event.target_title || 'MR'),
            project: projectName,
            id: event.target_iid,
          });
        } else if (event.target_type === 'Issue') {
          activity.issues.push({
            action: 'closed',
            title: String(event.target_title || 'Issue'),
            project: projectName,
            id: event.target_iid,
          });
        }
        break;

      case 'merged':
        if (event.target_type === 'MergeRequest') {
          activity.mergeRequests.push({
            action: 'merged',
            title: String(event.target_title || 'MR'),
            project: projectName,
            id: event.target_iid,
          });
        }
        break;
    }
  }

  private projectNameCache = new Map<number, string>();

  private async getProjectName(projectId: number): Promise<string> {
    if (this.projectNameCache.has(projectId)) {
      return this.projectNameCache.get(projectId)!;
    }

    try {
      const project = await this.client!.Projects.show(projectId);
      this.projectNameCache.set(projectId, project.name);
      return project.name;
    } catch {
      return `Project ${projectId}`;
    }
  }
}
