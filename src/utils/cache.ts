import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { GitLabActivity, CalendarEvent } from '../types/index.js';

const CACHE_FILE = path.join(homedir(), '.timesheet-mcp-cache.json');
const DEFAULT_CACHE_TTL = 3600000; // 1 hour in milliseconds

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  source: string;
}

interface CacheData {
  gitlab: {
    [dateKey: string]: CacheEntry<GitLabActivity>;
  };
  googleCalendar: {
    [dateKey: string]: CacheEntry<CalendarEvent[]>;
  };
  outlookCalendar: {
    [dateKey: string]: CacheEntry<CalendarEvent[]>;
  };
}

export class ActivityCache {
  private cache: CacheData = {
    gitlab: {},
    googleCalendar: {},
    outlookCalendar: {},
  };
  private cacheTTL: number = DEFAULT_CACHE_TTL;
  private cacheStats = {
    gitlabHits: 0,
    gitlabMisses: 0,
    googleHits: 0,
    googleMisses: 0,
    outlookHits: 0,
    outlookMisses: 0,
  };

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(CACHE_FILE, 'utf-8');
      this.cache = JSON.parse(data);
    } catch (error) {
      // Cache file doesn't exist yet, that's okay
      this.cache = {
        gitlab: {},
        googleCalendar: {},
        outlookCalendar: {},
      };
    }
  }

  async save(): Promise<void> {
    await fs.writeFile(CACHE_FILE, JSON.stringify(this.cache, null, 2), {
      mode: 0o600,
    });
  }

  private getDateKey(date: Date): string {
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp > this.cacheTTL;
  }

  // GitLab cache methods
  getGitLabActivity(date: Date): GitLabActivity | null {
    const key = this.getDateKey(date);
    const entry = this.cache.gitlab[key];

    if (!entry) {
      this.cacheStats.gitlabMisses++;
      return null;
    }

    if (this.isExpired(entry.timestamp)) {
      delete this.cache.gitlab[key];
      this.cacheStats.gitlabMisses++;
      return null;
    }

    this.cacheStats.gitlabHits++;
    return entry.data;
  }

  async setGitLabActivity(date: Date, activity: GitLabActivity): Promise<void> {
    const key = this.getDateKey(date);
    this.cache.gitlab[key] = {
      data: activity,
      timestamp: Date.now(),
      source: 'gitlab',
    };
    await this.save();
  }

  // Google Calendar cache methods
  getGoogleCalendarEvents(date: Date): CalendarEvent[] | null {
    const key = this.getDateKey(date);
    const entry = this.cache.googleCalendar[key];

    if (!entry) {
      this.cacheStats.googleMisses++;
      return null;
    }

    if (this.isExpired(entry.timestamp)) {
      delete this.cache.googleCalendar[key];
      this.cacheStats.googleMisses++;
      return null;
    }

    this.cacheStats.googleHits++;
    return entry.data;
  }

  async setGoogleCalendarEvents(date: Date, events: CalendarEvent[]): Promise<void> {
    const key = this.getDateKey(date);
    this.cache.googleCalendar[key] = {
      data: events,
      timestamp: Date.now(),
      source: 'google_calendar',
    };
    await this.save();
  }

  // Outlook Calendar cache methods
  getOutlookCalendarEvents(date: Date): CalendarEvent[] | null {
    const key = this.getDateKey(date);
    const entry = this.cache.outlookCalendar[key];

    if (!entry) {
      this.cacheStats.outlookMisses++;
      return null;
    }

    if (this.isExpired(entry.timestamp)) {
      delete this.cache.outlookCalendar[key];
      this.cacheStats.outlookMisses++;
      return null;
    }

    this.cacheStats.outlookHits++;
    return entry.data;
  }

  async setOutlookCalendarEvents(date: Date, events: CalendarEvent[]): Promise<void> {
    const key = this.getDateKey(date);
    this.cache.outlookCalendar[key] = {
      data: events,
      timestamp: Date.now(),
      source: 'outlook_calendar',
    };
    await this.save();
  }

  // Cache management
  async clearAll(): Promise<void> {
    this.cache = {
      gitlab: {},
      googleCalendar: {},
      outlookCalendar: {},
    };
    await this.save();
    this.resetStats();
  }

  async clearGitLab(): Promise<void> {
    this.cache.gitlab = {};
    await this.save();
  }

  async clearCalendars(): Promise<void> {
    this.cache.googleCalendar = {};
    this.cache.outlookCalendar = {};
    await this.save();
  }

  async clearExpired(): Promise<void> {
    const now = Date.now();

    // Clear expired GitLab entries
    for (const [key, entry] of Object.entries(this.cache.gitlab)) {
      if (now - entry.timestamp > this.cacheTTL) {
        delete this.cache.gitlab[key];
      }
    }

    // Clear expired Google Calendar entries
    for (const [key, entry] of Object.entries(this.cache.googleCalendar)) {
      if (now - entry.timestamp > this.cacheTTL) {
        delete this.cache.googleCalendar[key];
      }
    }

    // Clear expired Outlook Calendar entries
    for (const [key, entry] of Object.entries(this.cache.outlookCalendar)) {
      if (now - entry.timestamp > this.cacheTTL) {
        delete this.cache.outlookCalendar[key];
      }
    }

    await this.save();
  }

  getCacheStats() {
    const total = this.cacheStats.gitlabHits + this.cacheStats.gitlabMisses +
                  this.cacheStats.googleHits + this.cacheStats.googleMisses +
                  this.cacheStats.outlookHits + this.cacheStats.outlookMisses;

    const hits = this.cacheStats.gitlabHits + this.cacheStats.googleHits + this.cacheStats.outlookHits;
    const hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) : '0';

    return {
      ...this.cacheStats,
      totalHits: hits,
      totalRequests: total,
      hitRate: `${hitRate}%`,
    };
  }

  resetStats() {
    this.cacheStats = {
      gitlabHits: 0,
      gitlabMisses: 0,
      googleHits: 0,
      googleMisses: 0,
      outlookHits: 0,
      outlookMisses: 0,
    };
  }

  getCacheInfo() {
    return {
      gitlabEntries: Object.keys(this.cache.gitlab).length,
      googleCalendarEntries: Object.keys(this.cache.googleCalendar).length,
      outlookCalendarEntries: Object.keys(this.cache.outlookCalendar).length,
      cacheTTL: this.cacheTTL,
      cacheFile: CACHE_FILE,
    };
  }

  setCacheTTL(ttl: number) {
    this.cacheTTL = ttl;
  }
}
