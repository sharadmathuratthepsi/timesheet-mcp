import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  format,
  isSaturday,
  isSunday,
  startOfWeek,
  endOfWeek
} from 'date-fns';

export function getWorkingDaysForMonth(year: number, month: number): Date[] {
  const start = startOfMonth(new Date(year, month - 1));
  const end = endOfMonth(new Date(year, month - 1));

  const allDays = eachDayOfInterval({ start, end });

  return allDays.filter(day => {
    const isSat = isSaturday(day);
    const isSun = isSunday(day);

    // Skip Sundays always
    if (isSun) return false;

    // Include first Saturday of the month
    if (isSat) {
      const dayOfMonth = day.getDate();
      return dayOfMonth <= 7; // First week
    }

    return true; // Include all other days
  });
}

export function formatDate(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function formatDayOfWeek(date: Date): string {
  return format(date, 'EEEE');
}

export function getCurrentMonth(): { year: number; month: number } {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
}

export function parseMonthYear(input: string): { year: number; month: number } | null {
  // ONLY accepts format: YYYY-MM
  // LLM is instructed to always provide month in this exact format

  const dashMatch = input.match(/^(\d{4})-(\d{2})$/);
  if (dashMatch) {
    return {
      year: parseInt(dashMatch[1]),
      month: parseInt(dashMatch[2]),
    };
  }

  return null;
}

export function getWorkingDaysForWeek(weekStart: Date): Date[] {
  const start = startOfWeek(weekStart, { weekStartsOn: 1 }); // Monday
  const end = endOfWeek(weekStart, { weekStartsOn: 1 }); // Sunday

  const allDays = eachDayOfInterval({ start, end });

  return allDays.filter(day => {
    const isSat = isSaturday(day);
    const isSun = isSunday(day);

    // Skip Sundays always
    if (isSun) return false;

    // Include first Saturday of the month
    if (isSat) {
      const dayOfMonth = day.getDate();
      return dayOfMonth <= 7; // First week of month
    }

    return true; // Include all other days
  });
}

export function getCurrentWeek(): Date {
  return new Date();
}

export function parseWeekInput(input: string): Date | null {
  // ONLY accepts ISO format: YYYY-MM-DD (any date in the week)
  // LLM is instructed to always provide dates in this exact format

  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]) - 1; // Month is 0-indexed
    const day = parseInt(isoMatch[3]);
    return new Date(year, month, day); // Creates date in local timezone
  }

  return null;
}

export function formatWeekRange(weekStart: Date): string {
  const start = startOfWeek(weekStart, { weekStartsOn: 1 });
  const end = endOfWeek(weekStart, { weekStartsOn: 1 });
  return `${format(start, 'MMM dd')} - ${format(end, 'MMM dd, yyyy')}`;
}

export function parseDateInput(input: string): Date | null {
  // ONLY accepts ISO format: YYYY-MM-DD
  // LLM is instructed to always provide dates in this exact format

  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]) - 1; // Month is 0-indexed
    const day = parseInt(isoMatch[3]);
    return new Date(year, month, day); // Creates date in local timezone
  }

  return null;
}

export function getWorkingDaysForDateRange(startDate: Date, endDate: Date): Date[] {
  const allDays = eachDayOfInterval({ start: startDate, end: endDate });

  return allDays.filter(day => {
    const isSat = isSaturday(day);
    const isSun = isSunday(day);

    // Skip Sundays always
    if (isSun) return false;

    // Include first Saturday of the month
    if (isSat) {
      const dayOfMonth = day.getDate();
      return dayOfMonth <= 7; // First week of month
    }

    return true; // Include all other days
  });
}
