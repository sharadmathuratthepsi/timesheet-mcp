import { DayActivity, GitLabActivity } from '../types/index.js';
import { eachDayOfInterval } from 'date-fns';

interface DistributionResult {
  activities: DayActivity[];
  distributionInfo: {
    daysWithGaps: number;
    daysDistributed: number;
    message: string;
  };
}

export class ActivityDistributor {
  /**
   * Distributes activities from days with work to preceding days without activity
   * This handles cases where developers commit multiple days of work at once
   */
  distributeActivities(activities: DayActivity[]): DistributionResult {
    const distributed = [...activities];
    let gapDays = 0;
    let distributedDays = 0;

    // Sort by date to ensure proper order
    distributed.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (let i = 0; i < distributed.length; i++) {
      const current = distributed[i];
      const hasActivity = this.hasAnyActivity(current);

      if (!hasActivity) {
        // Found a day without activity - look ahead for the next day with activity
        const nextActivityIndex = this.findNextActivityDay(distributed, i);

        if (nextActivityIndex !== -1) {
          // Calculate the gap (how many days without activity)
          const gapSize = nextActivityIndex - i;
          const nextActivity = distributed[nextActivityIndex];

          // Distribute the next day's work across the gap
          this.distributeWorkAcrossGap(distributed, i, nextActivityIndex, gapSize);

          gapDays += gapSize;
          distributedDays++;
        }
      }
    }

    let message = '';
    if (distributedDays > 0) {
      message = `Note: ${gapDays} day(s) had no recorded activity. Work from subsequent days was distributed proportionally. Distributed entries are marked with [Distributed].`;
    }

    return {
      activities: distributed,
      distributionInfo: {
        daysWithGaps: gapDays,
        daysDistributed: distributedDays,
        message,
      },
    };
  }

  private hasAnyActivity(day: DayActivity): boolean {
    return (
      day.meetings.length > 0 ||
      day.gitlabActivity.commits.length > 0 ||
      day.gitlabActivity.mergeRequests.length > 0 ||
      day.gitlabActivity.issues.length > 0
    );
  }

  private findNextActivityDay(activities: DayActivity[], startIndex: number): number {
    for (let i = startIndex + 1; i < activities.length; i++) {
      if (this.hasAnyActivity(activities[i])) {
        return i;
      }
    }
    return -1; // No activity found
  }

  private distributeWorkAcrossGap(
    activities: DayActivity[],
    gapStart: number,
    activityIndex: number,
    gapSize: number
  ): void {
    const sourceActivity = activities[activityIndex];

    // Calculate how to split the work
    const commitsPerDay = Math.floor(sourceActivity.gitlabActivity.commits.length / (gapSize + 1));
    const mrsPerDay = Math.floor(sourceActivity.gitlabActivity.mergeRequests.length / (gapSize + 1));
    const issuesPerDay = Math.floor(sourceActivity.gitlabActivity.issues.length / (gapSize + 1));

    // Distribute commits
    let commitIndex = 0;
    for (let i = gapStart; i < activityIndex; i++) {
      const commitsToAdd = Math.min(commitsPerDay, sourceActivity.gitlabActivity.commits.length - commitIndex);
      if (commitsToAdd > 0) {
        const distributedCommits = sourceActivity.gitlabActivity.commits
          .slice(commitIndex, commitIndex + commitsToAdd)
          .map(commit => ({
            ...commit,
            message: `[Distributed] ${commit.message}`,
          }));

        activities[i].gitlabActivity.commits.push(...distributedCommits);
        commitIndex += commitsToAdd;
      }
    }

    // Distribute MRs
    let mrIndex = 0;
    for (let i = gapStart; i < activityIndex; i++) {
      const mrsToAdd = Math.min(mrsPerDay, sourceActivity.gitlabActivity.mergeRequests.length - mrIndex);
      if (mrsToAdd > 0) {
        const distributedMRs = sourceActivity.gitlabActivity.mergeRequests
          .slice(mrIndex, mrIndex + mrsToAdd)
          .map(mr => ({
            ...mr,
            title: `[Distributed] ${mr.title}`,
          }));

        activities[i].gitlabActivity.mergeRequests.push(...distributedMRs);
        mrIndex += mrsToAdd;
      }
    }

    // Distribute issues
    let issueIndex = 0;
    for (let i = gapStart; i < activityIndex; i++) {
      const issuesToAdd = Math.min(issuesPerDay, sourceActivity.gitlabActivity.issues.length - issueIndex);
      if (issuesToAdd > 0) {
        const distributedIssues = sourceActivity.gitlabActivity.issues
          .slice(issueIndex, issueIndex + issuesToAdd)
          .map(issue => ({
            ...issue,
            title: `[Distributed] ${issue.title}`,
          }));

        activities[i].gitlabActivity.issues.push(...distributedIssues);
        issueIndex += issuesToAdd;
      }
    }

    // Add a note to the original day that some work was distributed
    if (commitIndex > 0 || mrIndex > 0 || issueIndex > 0) {
      const note = {
        message: `[Note: Some activities from this day were distributed to previous ${gapSize} day(s) without recorded work]`,
        project: 'System',
        branch: 'distribution',
      };
      sourceActivity.gitlabActivity.commits.unshift(note);
    }
  }

  /**
   * More intelligent distribution that considers work patterns
   * For example, if there are 3 commits on day 4, and days 1-3 are empty,
   * it might distribute as: day1: planning/research, day2-3: implementation, day4: finalization
   */
  distributeActivitiesIntelligent(activities: DayActivity[]): DistributionResult {
    const distributed = [...activities];
    let gapDays = 0;
    let distributedDays = 0;

    distributed.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (let i = 0; i < distributed.length; i++) {
      const current = distributed[i];
      const hasActivity = this.hasAnyActivity(current);

      if (!hasActivity) {
        const nextActivityIndex = this.findNextActivityDay(distributed, i);

        if (nextActivityIndex !== -1) {
          const gapSize = nextActivityIndex - i;
          const nextActivity = distributed[nextActivityIndex];

          // Create work phases based on gap size
          this.distributeWorkPhases(distributed, i, nextActivityIndex, gapSize, nextActivity);

          gapDays += gapSize;
          distributedDays++;
        }
      }
    }

    let message = '';
    if (distributedDays > 0) {
      message = `Note: ${gapDays} day(s) had no recorded activity. Work phases were inferred and distributed. Entries are marked with [Phase: X].`;
    }

    return {
      activities: distributed,
      distributionInfo: {
        daysWithGaps: gapDays,
        daysDistributed: distributedDays,
        message,
      },
    };
  }

  private distributeWorkPhases(
    activities: DayActivity[],
    gapStart: number,
    activityIndex: number,
    gapSize: number,
    sourceActivity: DayActivity
  ): void {
    const phases = this.generateWorkPhases(gapSize, sourceActivity);

    for (let i = 0; i < phases.length && (gapStart + i) < activityIndex; i++) {
      const phase = phases[i];
      const dayIndex = gapStart + i;

      // Add phase description as a synthetic commit
      activities[dayIndex].gitlabActivity.commits.push({
        message: phase,
        project: 'Distributed Work',
        branch: 'phase-distribution',
      });
    }
  }

  private generateWorkPhases(gapSize: number, sourceActivity: DayActivity): string[] {
    const phases: string[] = [];
    const hasCommits = sourceActivity.gitlabActivity.commits.length > 0;
    const hasMRs = sourceActivity.gitlabActivity.mergeRequests.length > 0;
    const hasIssues = sourceActivity.gitlabActivity.issues.length > 0;

    // Determine work type from source activity
    const workSummary = this.summarizeWork(sourceActivity);

    if (gapSize === 1) {
      phases.push(`[Phase: Research & Planning] Preparation for: ${workSummary}`);
    } else if (gapSize === 2) {
      phases.push(`[Phase: Analysis] Initial work on: ${workSummary}`);
      phases.push(`[Phase: Development] Continued work on: ${workSummary}`);
    } else if (gapSize === 3) {
      phases.push(`[Phase: Planning] Planned work for: ${workSummary}`);
      phases.push(`[Phase: Implementation] Developed features for: ${workSummary}`);
      phases.push(`[Phase: Testing] Testing and refinement for: ${workSummary}`);
    } else {
      // For longer gaps, distribute evenly
      const phaseNames = ['Planning', 'Research', 'Design', 'Implementation', 'Testing', 'Refinement', 'Documentation'];
      for (let i = 0; i < gapSize; i++) {
        const phaseName = phaseNames[i % phaseNames.length];
        phases.push(`[Phase: ${phaseName}] Work on: ${workSummary}`);
      }
    }

    return phases;
  }

  private summarizeWork(activity: DayActivity): string {
    const parts: string[] = [];

    if (activity.gitlabActivity.commits.length > 0) {
      const firstCommit = activity.gitlabActivity.commits[0];
      parts.push(firstCommit.message.substring(0, 50));
    }

    if (activity.gitlabActivity.mergeRequests.length > 0) {
      const firstMR = activity.gitlabActivity.mergeRequests[0];
      parts.push(firstMR.title.substring(0, 50));
    }

    if (activity.gitlabActivity.issues.length > 0) {
      const firstIssue = activity.gitlabActivity.issues[0];
      parts.push(firstIssue.title.substring(0, 50));
    }

    return parts.join(', ') || 'project work';
  }
}
