import { Octokit } from '@octokit/rest';
import { GitLabActivity } from '../types/index.js';

export class GitHubIntegration {
  private client: Octokit | null = null;
  private username: string | null = null;

  async initialize(token: string): Promise<void> {
    this.client = new Octokit({
      auth: token,
    });

    // Get current user
    const { data: user } = await this.client.users.getAuthenticated();
    this.username = user.login;
  }

  async getActivityForDate(dateStr: string): Promise<GitLabActivity> {
    if (!this.client || !this.username) {
      throw new Error('GitHub client not initialized');
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
      mergeRequests: [], // We'll use this for Pull Requests
      issues: [],
    };

    try {
      // Get user's events for the day
      const { data: events } = await this.client.activity.listEventsForAuthenticatedUser({
        username: this.username,
        per_page: 100,
      });

      for (const event of events) {
        if (!event.created_at) continue;

        // Filter by date - extract YYYY-MM-DD from event timestamp
        const eventDateStr = (event.created_at as string).split('T')[0];
        if (eventDateStr !== dateStr) continue;

        const repoName = event.repo?.name || 'Unknown';

        switch (event.type) {
          case 'PushEvent':
            if ('payload' in event && event.payload && 'commits' in event.payload) {
              const payload = event.payload as any;
              const commits = payload.commits || [];
              for (const commit of commits) {
                activity.commits.push({
                  message: commit.message,
                  project: repoName,
                  branch: payload.ref?.replace('refs/heads/', '') || 'main',
                });
              }
            }
            break;

          case 'PullRequestEvent':
            if ('payload' in event && event.payload && 'action' in event.payload) {
              const payload = event.payload as any;
              const pr = payload.pull_request;
              let action: 'created' | 'reviewed' | 'approved' | 'commented' = 'created';

              if (payload.action === 'opened') {
                action = 'created';
              } else if (payload.action === 'closed' && pr?.merged) {
                action = 'approved';
              }

              activity.mergeRequests.push({
                action,
                title: pr?.title || 'PR',
                project: repoName,
              });
            }
            break;

          case 'PullRequestReviewEvent':
            if ('payload' in event && event.payload) {
              const payload = event.payload as any;
              const pr = payload.pull_request;
              const review = payload.review;

              let action: 'reviewed' | 'approved' | 'commented' = 'reviewed';
              if (review?.state === 'approved') {
                action = 'approved';
              } else if (review?.state === 'commented') {
                action = 'commented';
              }

              activity.mergeRequests.push({
                action,
                title: pr?.title || 'PR',
                project: repoName,
              });
            }
            break;

          case 'PullRequestReviewCommentEvent':
            if ('payload' in event && event.payload) {
              const payload = event.payload as any;
              const pr = payload.pull_request;

              activity.mergeRequests.push({
                action: 'commented',
                title: pr?.title || 'PR',
                project: repoName,
              });
            }
            break;

          case 'IssuesEvent':
            if ('payload' in event && event.payload && 'action' in event.payload) {
              const payload = event.payload as any;
              const issue = payload.issue;

              if (payload.action === 'opened') {
                activity.issues.push({
                  action: 'status_changed',
                  title: issue?.title || 'Issue',
                  project: repoName,
                  details: 'opened',
                });
              } else if (payload.action === 'closed') {
                activity.issues.push({
                  action: 'status_changed',
                  title: issue?.title || 'Issue',
                  project: repoName,
                  details: 'closed',
                });
              }
            }
            break;

          case 'IssueCommentEvent':
            if ('payload' in event && event.payload) {
              const payload = event.payload as any;
              const issue = payload.issue;

              // Check if it's actually a PR comment
              if (issue?.pull_request) {
                activity.mergeRequests.push({
                  action: 'commented',
                  title: issue.title || 'PR',
                  project: repoName,
                });
              } else {
                activity.issues.push({
                  action: 'commented',
                  title: issue?.title || 'Issue',
                  project: repoName,
                });
              }
            }
            break;
        }
      }

      // Also fetch commits directly for more detailed information
      await this.fetchCommitsForDate(dateStr, activity);

      // Fetch PR reviews
      await this.fetchPullRequestActivity(dateStr, activity);

    } catch (error) {
      console.error('Error fetching GitHub activity:', error);
    }

    return activity;
  }

  private async fetchCommitsForDate(dateStr: string, activity: GitLabActivity): Promise<void> {
    if (!this.client || !this.username) return;

    try {
      // Parse date for API parameters
      const [year, month, day] = dateStr.split('-').map(Number);
      const date = new Date(year, month - 1, day);

      // Create start and end timestamps in ISO format for API
      const dayStart = new Date(year, month - 1, day, 0, 0, 0);
      const dayEnd = new Date(year, month - 1, day, 23, 59, 59);

      // Get all repos the user has access to
      const { data: repos } = await this.client.repos.listForAuthenticatedUser({
        sort: 'pushed',
        per_page: 50,
      });

      for (const repo of repos) {
        try {
          const { data: commits } = await this.client.repos.listCommits({
            owner: repo.owner.login,
            repo: repo.name,
            author: this.username,
            since: dayStart.toISOString(),
            until: dayEnd.toISOString(),
          });

          for (const commit of commits) {
            // Filter by date - extract YYYY-MM-DD from commit timestamp
            if (commit.commit.author?.date) {
              const commitDateStr = commit.commit.author.date.split('T')[0];
              if (commitDateStr !== dateStr) continue;
            }

            // Avoid duplicates
            const exists = activity.commits.some(c => c.message === commit.commit.message);
            if (!exists && commit.commit.message) {
              activity.commits.push({
                message: commit.commit.message,
                project: repo.full_name,
                branch: repo.default_branch || 'main',
              });
            }
          }
        } catch (error) {
          // Skip repos we can't access
          continue;
        }
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    }
  }

  private async fetchPullRequestActivity(dateStr: string, activity: GitLabActivity): Promise<void> {
    if (!this.client || !this.username) return;

    try {
      // Search for PRs created by user on this date
      const createdQuery = `author:${this.username} is:pr created:${dateStr}`;
      const { data: createdResults } = await this.client.search.issuesAndPullRequests({
        q: createdQuery,
        per_page: 100,
      });

      for (const pr of createdResults.items) {
        if (pr.pull_request) {
          const repoName = pr.repository_url?.split('/').slice(-2).join('/') || 'Unknown';
          const exists = activity.mergeRequests.some(
            m => m.title === pr.title && m.project === repoName
          );
          if (!exists) {
            activity.mergeRequests.push({
              action: 'created',
              title: pr.title,
              project: repoName,
            });
          }
        }
      }

      // Search for PRs reviewed by user on this date
      const reviewedQuery = `reviewed-by:${this.username} is:pr updated:${dateStr}`;
      const { data: reviewedResults } = await this.client.search.issuesAndPullRequests({
        q: reviewedQuery,
        per_page: 100,
      });

      for (const pr of reviewedResults.items) {
        if (pr.pull_request) {
          const repoName = pr.repository_url?.split('/').slice(-2).join('/') || 'Unknown';
          const exists = activity.mergeRequests.some(
            m => m.title === pr.title && m.project === repoName
          );
          if (!exists) {
            activity.mergeRequests.push({
              action: 'reviewed',
              title: pr.title,
              project: repoName,
            });
          }
        }
      }
    } catch (error) {
      console.error('Error fetching PR activity:', error);
    }
  }
}
