export interface ProgressStep {
  step: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

export class ProgressTracker {
  private steps: ProgressStep[] = [];
  private currentStep: string | null = null;
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  start(step: string): void {
    if (this.currentStep) {
      this.complete();
    }
    this.currentStep = step;
    this.steps.push({
      step,
      startTime: Date.now(),
    });
  }

  update(step: string): void {
    // Update the current step description without completing it
    // This allows for dynamic progress updates within the same logical step
    if (this.currentStep && this.steps.length > 0) {
      const lastStep = this.steps[this.steps.length - 1];
      lastStep.step = step;
      this.currentStep = step;
    } else {
      // If no step is in progress, start a new one
      this.start(step);
    }
  }

  complete(): void {
    if (this.currentStep && this.steps.length > 0) {
      const lastStep = this.steps[this.steps.length - 1];
      lastStep.endTime = Date.now();
      lastStep.duration = lastStep.endTime - lastStep.startTime;
      this.currentStep = null;
    }
  }

  getReport(): string {
    this.complete(); // Complete any pending step

    const totalDuration = Date.now() - this.startTime;
    let report = '⏱️ **Processing Steps:**\n';

    for (const step of this.steps) {
      const duration = step.duration || 0;
      const icon = duration > 2000 ? '⏳' : '✓';
      report += `${icon} ${step.step} (${duration}ms)\n`;
    }

    report += `\n**Total time:** ${totalDuration}ms\n`;
    return report;
  }

  getSummary(): string {
    const totalDuration = Date.now() - this.startTime;
    return `Completed in ${(totalDuration / 1000).toFixed(2)}s`;
  }
}
