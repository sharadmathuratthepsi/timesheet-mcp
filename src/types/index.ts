export interface TokenStore {
  gitlab?: string;
  github?: string;
  google?: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  };
  outlook?: {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  };
  psi?: {
    username: string;
    password: string;
  };
}

export interface GitLabActivity {
  date: Date;
  commits: Array<{
    message: string;
    project: string;
    branch: string;
  }>;
  mergeRequests: Array<{
    action: 'created' | 'reviewed' | 'approved' | 'commented' | 'closed' | 'merged';
    title: string;
    project: string;
    id?: number;
  }>;
  issues: Array<{
    action: 'commented' | 'status_changed' | 'assigned' | 'opened' | 'closed';
    title: string;
    project: string;
    id?: number;
    details?: string;
  }>;
}

export interface CalendarEvent {
  title: string;
  start: Date;
  end: Date;
  attendees?: number;
}

export interface DayActivity {
  date: Date;
  meetings: CalendarEvent[];
  gitlabActivity: GitLabActivity;
  description: string;
}

export interface TimesheetEntry {
  date: string;
  dayOfWeek: string;
  description: string;
  wordCount: number;
}

export interface PSITimesheetEntry {
  date: string;
  description: string;
  hours?: number;
  projectName?: string;
}

export interface Config {
  gitlab?: {
    url: string;
    token?: string;
  };
  github?: {
    token?: string;
  };
  google?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  outlook?: {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    redirectUri: string;
  };
  psi?: {
    url: string;
    username?: string;
    password?: string;
  };
}
