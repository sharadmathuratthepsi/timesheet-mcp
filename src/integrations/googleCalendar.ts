import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { CalendarEvent } from '../types/index.js';

export class GoogleCalendarIntegration {
  private oauth2Client: OAuth2Client | null = null;
  private calendar: calendar_v3.Calendar | null = null;
  private onTokenRefresh?: (tokens: { access_token: string; refresh_token: string; expiry_date: number }) => Promise<void>;

  async initialize(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    tokens?: { access_token: string; refresh_token: string; expiry_date: number },
    onTokenRefresh?: (tokens: { access_token: string; refresh_token: string; expiry_date: number }) => Promise<void>
  ): Promise<void> {
    this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    this.onTokenRefresh = onTokenRefresh;

    if (tokens) {
      this.oauth2Client.setCredentials(tokens);
    }

    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  getAuthUrl(): string {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized');
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.readonly'],
      prompt: 'consent',
    });
  }

  async setAuthorizationCode(code: string): Promise<{
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  }> {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized');
    }

    const { tokens } = await this.oauth2Client.getToken(code);
    this.oauth2Client.setCredentials(tokens);

    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      throw new Error('Invalid tokens received');
    }

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    };
  }

  async refreshAccessToken(): Promise<{
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  }> {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 client not initialized');
    }

    const { credentials } = await this.oauth2Client.refreshAccessToken();

    if (!credentials.access_token || !credentials.refresh_token || !credentials.expiry_date) {
      throw new Error('Failed to refresh tokens');
    }

    const tokens = {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expiry_date: credentials.expiry_date,
    };

    // Persist refreshed tokens if callback is provided
    if (this.onTokenRefresh) {
      await this.onTokenRefresh(tokens);
    }

    return tokens;
  }

  async getEventsForDate(dateStr: string): Promise<CalendarEvent[]> {
    if (!this.calendar || !this.oauth2Client) {
      throw new Error('Google Calendar not initialized');
    }

    // Validate YYYY-MM-DD format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('Date must be in YYYY-MM-DD format (e.g., "2025-12-01")');
    }

    // Parse date for local day start/end times
    const [year, month, day] = dateStr.split('-').map(Number);
    const dayStart = new Date(year, month - 1, day, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59);

    try {
      // Check if token needs refresh
      const expiryDate = this.oauth2Client.credentials.expiry_date;
      if (expiryDate && expiryDate < Date.now()) {
        await this.refreshAccessToken();
      }

      const response = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = response.data.items || [];

      return events
        .filter(event => {
          // Filter out all-day events and events without start/end times
          return event.start?.dateTime && event.end?.dateTime;
        })
        .map(event => ({
          title: event.summary || 'Untitled Event',
          start: new Date(event.start!.dateTime!),
          end: new Date(event.end!.dateTime!),
          attendees: event.attendees?.length || 0,
        }));
    } catch (error: any) {
      if (error.code === 401) {
        // Token expired, try to refresh
        await this.refreshAccessToken();
        return this.getEventsForDate(dateStr);
      }
      throw error;
    }
  }

  isAuthenticated(): boolean {
    return this.oauth2Client !== null && this.oauth2Client.credentials.access_token !== undefined;
  }
}
