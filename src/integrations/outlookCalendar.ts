import { Client } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { CalendarEvent } from '../types/index.js';

export class OutlookCalendarIntegration {
  private msalClient: ConfidentialClientApplication | null = null;
  private graphClient: Client | null = null;
  private accessToken: string | null = null;

  async initialize(
    clientId: string,
    clientSecret: string,
    tenantId: string,
    tokens?: { access_token: string; refresh_token: string }
  ): Promise<void> {
    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });

    if (tokens) {
      this.accessToken = tokens.access_token;
      this.graphClient = Client.init({
        authProvider: (done) => {
          done(null, this.accessToken!);
        },
      });
    }
  }

  getAuthUrl(redirectUri: string): string {
    if (!this.msalClient) {
      throw new Error('MSAL client not initialized');
    }

    const clientId = (this.msalClient as any).config.auth.clientId;
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&scope=${encodeURIComponent('https://graph.microsoft.com/Calendars.Read offline_access')}`;
  }

  async setAuthorizationCode(
    code: string,
    redirectUri: string
  ): Promise<{ access_token: string; refresh_token: string; expiry_date: number }> {
    if (!this.msalClient) {
      throw new Error('MSAL client not initialized');
    }

    const tokenResponse = await this.msalClient.acquireTokenByCode({
      code,
      scopes: ['https://graph.microsoft.com/Calendars.Read'],
      redirectUri,
    });

    if (!tokenResponse || !tokenResponse.accessToken) {
      throw new Error('Failed to acquire token');
    }

    this.accessToken = tokenResponse.accessToken;
    this.graphClient = Client.init({
      authProvider: (done) => {
        done(null, this.accessToken!);
      },
    });

    return {
      access_token: tokenResponse.accessToken,
      refresh_token: (tokenResponse as any).refreshToken || '',
      expiry_date: tokenResponse.expiresOn ? tokenResponse.expiresOn.getTime() : Date.now() + 3600000,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expiry_date: number;
  }> {
    if (!this.msalClient) {
      throw new Error('MSAL client not initialized');
    }

    const tokenResponse = await this.msalClient.acquireTokenByRefreshToken({
      refreshToken,
      scopes: ['https://graph.microsoft.com/Calendars.Read'],
    });

    if (!tokenResponse || !tokenResponse.accessToken) {
      throw new Error('Failed to refresh token');
    }

    this.accessToken = tokenResponse.accessToken;
    this.graphClient = Client.init({
      authProvider: (done) => {
        done(null, this.accessToken!);
      },
    });

    return {
      access_token: tokenResponse.accessToken,
      refresh_token: (tokenResponse as any).refreshToken || refreshToken,
      expiry_date: tokenResponse.expiresOn ? tokenResponse.expiresOn.getTime() : Date.now() + 3600000,
    };
  }

  async getEventsForDate(dateStr: string): Promise<CalendarEvent[]> {
    if (!this.graphClient) {
      throw new Error('Outlook Calendar not initialized');
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
      const response = await this.graphClient
        .api('/me/calendar/calendarView')
        .query({
          startDateTime: dayStart.toISOString(),
          endDateTime: dayEnd.toISOString(),
        })
        .select('subject,start,end,attendees')
        .orderby('start/dateTime')
        .get();

      const events = response.value || [];

      return events
        .filter((event: any) => {
          // Filter out all-day events
          return event.start?.dateTime && event.end?.dateTime;
        })
        .map((event: any) => ({
          title: event.subject || 'Untitled Event',
          start: new Date(event.start.dateTime + 'Z'), // Add Z for UTC
          end: new Date(event.end.dateTime + 'Z'),
          attendees: event.attendees?.length || 0,
        }));
    } catch (error: any) {
      if (error.statusCode === 401) {
        throw new Error('Authentication expired. Please re-authenticate.');
      }
      throw error;
    }
  }

  isAuthenticated(): boolean {
    return this.graphClient !== null && this.accessToken !== null;
  }
}
