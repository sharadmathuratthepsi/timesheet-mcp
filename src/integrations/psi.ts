import puppeteer, { Browser, Page } from 'puppeteer';
import { PSITimesheetEntry } from '../types/index.js';

export class PSITimesheetIntegration {
  private url: string;
  private username: string;
  private password: string;
  private browser: Browser | null = null;

  constructor(url: string, username: string, password: string) {
    this.url = url;
    this.username = username;
    this.password = password;
  }

  async initialize(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: false, // Set to true for production
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async authenticate(page: Page): Promise<void> {
    // Navigate to the PSI timesheet page
    await page.goto(this.url, { waitUntil: 'networkidle2' });

    // Handle browser authentication dialog
    await page.authenticate({
      username: this.username,
      password: this.password
    });

    // Wait for page to load after authentication
    await page.waitForSelector('body', { timeout: 30000 });
  }

  /**
   * Get available tasks from PSI for a specific date
   * Returns hierarchical task list for user to select from
   */
  async getTasks(date: string): Promise<{ success: boolean; message: string; tasks?: any }> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();

    // Set a larger viewport to see the complete webpage
    await page.setViewport({ width: 1920, height: 1080 });

    try {
      // Authenticate and land on the summary page
      await this.authenticate(page);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Find and click the correct timesheet row for this date
      const clicked = await this.findAndClickTimesheetRow(page, date);
      if (!clicked) {
        return {
          success: false,
          message: `❌ Could not find timesheet period for date: ${date}`
        };
      }

      // Wait for navigation to the detail page
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get tasks from the dialog
      const taskResult = await this.extractTasksFromDialog(page);

      return taskResult;
    } catch (error) {
      console.error('Error getting tasks:', error);
      return {
        success: false,
        message: `Failed to get tasks: ${error instanceof Error ? error.message : String(error)}`
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Submit timesheet with selected task
   * @param date - Date in YYYY-MM-DD format
   * @param taskIndex - Index of task from getTasks() result
   * @param description - Timesheet description (max 255 chars)
   * @param hours - Hours worked (e.g., "8h")
   */
  async submitTimesheet(date: string, taskIndex: number, description: string, hours: string = '8h'): Promise<{ success: boolean; message: string }> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();

    // Set a larger viewport to see the complete webpage
    await page.setViewport({ width: 1920, height: 1080 });

    try {
      // Authenticate and land on the summary page
      await this.authenticate(page);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Find and click the correct timesheet row for this date
      const clicked = await this.findAndClickTimesheetRow(page, date);
      if (!clicked) {
        return {
          success: false,
          message: `❌ Could not find timesheet period for date: ${date}`
        };
      }

      // Wait for navigation to the detail page
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Fill timesheet with selected task
      const fillResult = await this.fillTimesheetWithTask(page, taskIndex, description, hours);

      return fillResult;
    } catch (error) {
      console.error('Error submitting timesheet:', error);
      return {
        success: false,
        message: `Failed to submit timesheet: ${error instanceof Error ? error.message : String(error)}`
      };
    } finally {
      await page.close();
    }
  }

  private async findAndClickTimesheetRow(page: Page, dateStr: string): Promise<boolean> {
    // Parse the date to create the expected pattern
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const monthName = date.toLocaleString('en-US', { month: 'long' });

    // Create the expected period text pattern
    const periodPattern = `${day}-${monthName}-${year} (${month}/${day}/${year} - ${month}/${day}/${year})`;

    // Find all cells with XmlGridWrappedCell class
    const cells = await page.$$('td.XmlGridWrappedCell');

    for (const cell of cells) {
      // Check if this cell contains an 'a' tag with class XmlGridNonLinkCell
      const link = await cell.$('a.XmlGridNonLinkCell');

      if (link) {
        const cellText = await page.evaluate(el => el.textContent?.trim() || '', link);

        // Check if the text matches our target period
        if (cellText === periodPattern || cellText.includes(`(${month}/${day}/${year}`)) {
          // Find the parent row and get the first cell's link using XPath
          const row = await cell.evaluateHandle((el) => {
            let current = el.parentElement;
            while (current && current.tagName !== 'TR') {
              current = current.parentElement;
            }
            return current;
          });

          if (row && row.asElement()) {
            // Find the first 'a' tag in the row
            const links = await row.asElement()!.$$('a');
            if (links.length > 0) {
              // Click the first link (should be the timesheet name link)
              await links[0].click();
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Extract tasks from the dialog - used by getTasks()
   */
  private async extractTasksFromDialog(page: Page): Promise<{ success: boolean; message: string; tasks?: any }> {
    const logs: string[] = [];

    // Step 1: Click Timesheet tab to ensure we're on the right tab
    logs.push('🔍 Looking for Timesheet tab...');
    const timesheetTab = await page.$('li[id*="Home-title"]');
    if (timesheetTab) {
      const timesheetLink = await timesheetTab.$('a');
      if (timesheetLink) {
        await timesheetLink.click();
        logs.push('✅ Clicked Timesheet tab');
      }
    } else {
      logs.push('⚠️ Could not find Timesheet tab, continuing anyway...');
    }
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds for tab to load

    // Step 2: Click "Add Row" button
    logs.push('🔍 Looking for Add Row button...');
    const addRowButton = await page.$('a[id*="AddLine-Large"]');
    if (addRowButton) {
      logs.push('✅ Found Add Row button');
      await addRowButton.click();
      logs.push('✅ Clicked Add Row button');
    } else {
      logs.push('❌ Could not find Add Row button');
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Click "Select From Existing Assignments"
    logs.push('🔍 Looking for "Select From Existing Assignments" option...');
    const existingAssignmentsButton = await page.$('a[id*="AddNewLine-Menu16"]');
    if (existingAssignmentsButton) {
      logs.push('✅ Found "Select From Existing Assignments" button');
      await existingAssignmentsButton.click();
      logs.push('✅ Clicked "Select From Existing Assignments"');
    } else {
      logs.push('❌ Could not find "Select From Existing Assignments" button');
    }

    // Wait for dialog iframe to load
    logs.push('🔍 Waiting for task list dialog iframe to load...');

    // Wait up to 10 seconds for iframe to appear
    let dialogFrame = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Find iframe with src containing SelectTaskDlg.aspx
      const frames = page.frames();
      dialogFrame = frames.find(frame => frame.url().includes('SelectTaskDlg.aspx'));

      if (dialogFrame) {
        logs.push(`✅ Found dialog iframe after ${i + 1} seconds: ${dialogFrame.url()}`);
        break;
      }
    }

    // Step 4: Extract task list from dialog iframe
    if (dialogFrame) {
      // Wait for tree-results to appear inside the iframe
      let taskListDiv = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        taskListDiv = await dialogFrame.$('div.tree-results');
        if (taskListDiv) {
          logs.push(`✅ Found tree-results div inside iframe after ${i + 1} seconds`);
          break;
        }
      }

      if (taskListDiv) {
        logs.push('✅ Found task list dialog, now expanding all tree nodes...');

        // First, expand all accordion nodes recursively
        let expandedCount = 0;
        let previousCount = -1;
        let iterations = 0;
        const maxIterations = 20; // Prevent infinite loop

        while (expandedCount !== previousCount && iterations < maxIterations) {
          previousCount = expandedCount;
          iterations++;

          // Find all expand icons and click them
          const newlyExpanded = await dialogFrame.evaluate(() => {
            const expandIcons = Array.from(document.querySelectorAll('.ms-commentexpand-iconouter'));
            let clicked = 0;

            for (const icon of expandIcons) {
              const parent = icon.parentElement;
              if (!parent) continue;

              // Check if this node has children container
              const childrenContainer = parent.parentElement?.querySelector('.outer-children-container') as HTMLElement;
              if (childrenContainer && childrenContainer.style.display === 'none') {
                // This node is collapsed, click to expand
                (icon as HTMLElement).click();
                clicked++;
              }
            }

            return clicked;
          });

          expandedCount += newlyExpanded;
          logs.push(`🔄 Iteration ${iterations}: Expanded ${newlyExpanded} nodes (total: ${expandedCount})`);

          // Wait a bit for the DOM to update after expansion
          if (newlyExpanded > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        logs.push(`✅ Tree expansion complete after ${iterations} iterations. Total nodes expanded: ${expandedCount}`);

        // Now extract all checkboxes from the fully expanded tree
        const taskStructure = await dialogFrame.evaluate(() => {
          const treeResults = document.querySelector('div.tree-results');
          if (!treeResults) return { html: '', tasks: [], totalCheckboxes: 0, hierarchicalView: '' };

          // Get the full HTML structure (first 5000 chars for better visibility)
          const html = treeResults.outerHTML.substring(0, 5000);

          // Find ALL checkbox inputs recursively throughout the entire expanded tree
          const checkboxes = Array.from(treeResults.querySelectorAll('input[type="checkbox"]'));
          const totalCheckboxes = checkboxes.length;

          const tasks = checkboxes.map((checkbox, index) => {
            // Get the parent element
            const parent = checkbox.parentElement;

            // Find sibling span or label with text - look at immediate siblings first
            let labelText = '';
            let allSiblingText = '';

            if (parent) {
              // Get all text from next siblings (spans, labels, text nodes)
              let sibling = checkbox.nextSibling;
              const siblingTexts: string[] = [];
              while (sibling) {
                if (sibling.nodeType === Node.TEXT_NODE) {
                  const text = sibling.textContent?.trim();
                  if (text) siblingTexts.push(text);
                } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                  const elem = sibling as Element;
                  const text = elem.textContent?.trim();
                  if (text) siblingTexts.push(text);
                }
                sibling = sibling.nextSibling;
              }
              allSiblingText = siblingTexts.join(' ');

              // Also check spans within parent
              const spans = Array.from(parent.querySelectorAll('span'));
              const spanText = spans.map(span => span.textContent?.trim()).filter(t => t).join(' ');

              // Prefer sibling text, fallback to span text
              labelText = allSiblingText || spanText;

              // If still no text, get all text content from parent (excluding checkbox)
              if (!labelText && parent.textContent) {
                labelText = parent.textContent.trim();
              }
            }

            // Calculate depth by counting .inner-children-container ancestors
            let depth = 0;
            let ancestor = parent;
            const ancestorPath: string[] = [];
            while (ancestor && ancestor !== treeResults) {
              if (ancestor.classList) {
                const classes = Array.from(ancestor.classList);
                ancestorPath.push(`${ancestor.tagName}.${classes.join('.')}`);
                if (classes.includes('inner-children-container')) {
                  depth++;
                }
              }
              ancestor = ancestor.parentElement;
            }

            return {
              index: index,
              checkboxId: checkbox.id || '',
              checkboxName: (checkbox as HTMLInputElement).name || '',
              checkboxValue: (checkbox as HTMLInputElement).value || '',
              checkboxClass: checkbox.className || '',
              labelText: labelText,
              depth: depth,
              ancestorPath: ancestorPath.slice(0, 10).join(' > '), // Show first 10 ancestors
              parentTag: parent?.tagName || '',
              parentId: parent?.id || '',
              parentClass: parent?.className || '',
              disabled: checkbox.hasAttribute('disabled'),
              attributes: Array.from(checkbox.attributes).reduce((acc, attr) => {
                acc[attr.name] = attr.value;
                return acc;
              }, {} as Record<string, string>)
            };
          });

          // Create hierarchical text view
          const hierarchicalLines = tasks.map(task => {
            const indent = '  '.repeat(task.depth);
            const status = task.disabled ? '[DISABLED]' : '[ENABLED]';
            return `${indent}[${task.index}] ${status} ${task.labelText}`;
          });
          const hierarchicalView = hierarchicalLines.join('\n');

          return { html, tasks, totalCheckboxes, hierarchicalView };
        });

        logs.push(`✅ Found ${taskStructure.totalCheckboxes} total checkboxes in fully expanded tree`);

        const message = `${logs.join('\n')}\n\n📋 Hierarchical Tree View:\n${taskStructure.hierarchicalView}\n\n📋 HTML Structure (first 5000 chars):\n${taskStructure.html}\n\n📋 All Task Checkboxes JSON (showing all ${taskStructure.tasks.length}):\n${JSON.stringify(taskStructure.tasks, null, 2)}`;

        return {
          success: true,
          message,
          tasks: taskStructure
        };
      } else {
        logs.push('❌ Could not find tree-results div inside iframe after waiting 10 seconds');
        return { success: false, message: logs.join('\n') };
      }
    } else {
      logs.push('❌ Could not find dialog iframe with SelectTaskDlg.aspx after waiting 10 seconds');
      return { success: false, message: logs.join('\n') };
    }
  }

  /**
   * Fill timesheet with selected task and description
   */
  private async fillTimesheetWithTask(page: Page, taskIndex: number, description: string, hours: string): Promise<{ success: boolean; message: string }> {
    const logs: string[] = [];

    // Step 1: Click all existing checkboxes and remove tasks
    const checkboxCount = await page.evaluate(() => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((checkbox) => {
        if (!(checkbox as HTMLInputElement).checked) {
          (checkbox as HTMLElement).click();
        }
      });
      return checkboxes.length;
    });
    logs.push(`✅ Clicked ${checkboxCount} checkboxes to remove existing tasks`);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 2: Click Options tab
    logs.push('🔍 Looking for Options tab...');
    const optionsTab = await page.$('li[id*="Options-title"]');
    if (optionsTab) {
      const optionsLink = await optionsTab.$('a');
      if (optionsLink) {
        await optionsLink.click();
        logs.push('✅ Clicked Options tab');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Click RemoveTask button
    logs.push('🔍 Looking for RemoveTask button...');
    const allAnchors = await page.$$('a');
    for (const anchor of allAnchors) {
      const anchorId = await page.evaluate(el => el.id, anchor);
      if (anchorId && anchorId.includes('RemoveTask')) {
        await anchor.click();
        logs.push('✅ Clicked RemoveTask button');
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 4: Switch back to Timesheet tab
    logs.push('🔍 Switching to Timesheet tab...');
    const timesheetTab = await page.$('li[id*="Home-title"]');
    if (timesheetTab) {
      const timesheetLink = await timesheetTab.$('a');
      if (timesheetLink) {
        await timesheetLink.click();
        logs.push('✅ Clicked Timesheet tab');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 5: Click "Add Row" button
    logs.push('🔍 Clicking Add Row button...');
    const addRowButton = await page.$('a[id*="AddLine-Large"]');
    if (addRowButton) {
      await addRowButton.click();
      logs.push('✅ Clicked Add Row button');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 6: Click "Select From Existing Assignments"
    logs.push('🔍 Clicking "Select From Existing Assignments"...');
    const existingAssignmentsButton = await page.$('a[id*="AddNewLine-Menu16"]');
    if (existingAssignmentsButton) {
      await existingAssignmentsButton.click();
      logs.push('✅ Clicked "Select From Existing Assignments"');
    }

    // Step 7: Wait for dialog iframe
    logs.push('🔍 Waiting for task dialog iframe...');
    let dialogFrame = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const frames = page.frames();
      dialogFrame = frames.find(frame => frame.url().includes('SelectTaskDlg.aspx'));
      if (dialogFrame) {
        logs.push(`✅ Found dialog iframe after ${i + 1} seconds`);
        break;
      }
    }

    if (!dialogFrame) {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not find dialog iframe` };
    }

    // Step 8: Wait for tree-results and expand all nodes
    let taskListDiv = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      taskListDiv = await dialogFrame.$('div.tree-results');
      if (taskListDiv) {
        logs.push(`✅ Found tree-results div after ${i + 1} seconds`);
        break;
      }
    }

    if (!taskListDiv) {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not find tree-results div` };
    }

    // Expand all nodes
    logs.push('🔍 Expanding all tree nodes...');
    let expandedCount = 0;
    for (let iteration = 0; iteration < 20; iteration++) {
      const newlyExpanded = await dialogFrame.evaluate(() => {
        const expandIcons = Array.from(document.querySelectorAll('.ms-commentexpand-iconouter'));
        let clicked = 0;
        for (const icon of expandIcons) {
          const parent = icon.parentElement;
          if (!parent) continue;
          const childrenContainer = parent.parentElement?.querySelector('.outer-children-container') as HTMLElement;
          if (childrenContainer && childrenContainer.style.display === 'none') {
            (icon as HTMLElement).click();
            clicked++;
          }
        }
        return clicked;
      });
      expandedCount += newlyExpanded;
      if (newlyExpanded === 0) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    logs.push(`✅ Expanded ${expandedCount} tree nodes`);

    // Step 9: Click the checkbox at taskIndex
    logs.push(`🔍 Selecting checkbox at index ${taskIndex}...`);
    const checkboxClicked = await dialogFrame.evaluate((index) => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      if (index >= 0 && index < checkboxes.length) {
        const checkbox = checkboxes[index] as HTMLInputElement;
        if (!checkbox.disabled) {
          checkbox.click();
          return true;
        }
      }
      return false;
    }, taskIndex);

    if (!checkboxClicked) {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not click checkbox at index ${taskIndex}` };
    }
    logs.push(`✅ Selected checkbox at index ${taskIndex}`);

    // Step 10: Fill description field
    logs.push('🔍 Filling description field...');
    const descriptionField = await dialogFrame.$('input[type="TEXT"][id*="idComment"]');
    if (descriptionField) {
      await descriptionField.click({ clickCount: 3 }); // Select all
      await descriptionField.type(description);
      logs.push(`✅ Filled description: ${description}`);
    } else {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not find description field` };
    }

    // Step 11: Click OK button
    logs.push('🔍 Clicking OK button...');
    const okButton = await dialogFrame.$('input[type="button"][value="OK"]');
    if (okButton) {
      await okButton.click();
      logs.push('✅ Clicked OK button');
    } else {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not find OK button` };
    }

    // Wait for dialog to close
    logs.push('⏳ Waiting for dialog to close...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Step 12: Wait for timesheet table to fully load with date columns
    logs.push('🔍 Waiting for timesheet table to load with date columns...');

    let tableReady = false;
    for (let i = 0; i < 15; i++) {
      const hasDateColumn = await page.evaluate(() => {
        const table = document.querySelector('table[id*="TimesheetPartJSGridControl_rightpane_mainTable"]');
        if (!table) return false;

        const tbody = table.children[0];
        if (!tbody) return false;

        const secondRow = tbody.children[1];
        if (!secondRow) return false;

        // Check if second cell exists (date column)
        return secondRow.children.length >= 2;
      });

      if (hasDateColumn) {
        tableReady = true;
        logs.push(`✅ Table ready with date column after ${i + 1} seconds`);
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!tableReady) {
      return { success: false, message: `${logs.join('\n')}\n❌ Table did not load with date column after 15 seconds` };
    }

    // Step 13: Find and click the FIRST "Actual" hours cell (empty cell in row 2)
    // Table structure: Row 1=header, Row 2=First Actual (EMPTY - this is what we need), Row 3=First Planned, Row 4=Second Actual (0h - auto-populated), Row 5=Second Planned
    logs.push('🔍 Looking for the first Actual hours cell (empty cell in row 2)...');

    // Debug: Render complete table HTML
    const tableHTML = await page.evaluate(() => {
      const table = document.querySelector('table[id*="TimesheetPartJSGridControl_rightpane_mainTable"]');
      if (!table) return 'Table not found';
      return table.outerHTML;
    });
    logs.push(`📋 Complete Table HTML (first 10000 chars):\n${tableHTML.substring(0, 10000)}`);

    // Debug: Log detailed table structure
    const tableInfo = await page.evaluate(() => {
      const table = document.querySelector('table[id*="TimesheetPartJSGridControl_rightpane_mainTable"]');
      if (!table) return { rows: 0, structure: 'Table not found' };

      const tbody = table.querySelector('tbody');
      if (!tbody) return { rows: 0, structure: 'No tbody found' };

      const rows = tbody.querySelectorAll('tr');
      const structure = Array.from(rows).slice(0, 6).map((row, idx) => {
        const cells = row.querySelectorAll('td, th');
        const cellContents = Array.from(cells).map((c, i) => {
          const text = c.textContent?.trim() || '(empty)';
          return `Col${i + 1}:"${text}"`;
        }).join(', ');
        return `Row${idx + 1}: ${cells.length} cells [${cellContents}]`;
      }).join('; ');

      return { rows: rows.length, structure };
    });
    logs.push(`📊 Table structure: ${tableInfo.structure}`);

    // SharePoint JSGrid approach: Use direct table path and mousedown/mouseup events
    logs.push('🔍 Using SharePoint JSGrid approach with hidden input field...');

    // Function to select cell and set value - needs to run TWICE for SharePoint grid
    const setCellValue = async (value: string, attempt: number) => {
      const result = await page.evaluate(async (val) => {
        const table = document.querySelector('table[id*="TimesheetPartJSGridControl_rightpane_mainTable"]');
        if (!table) return { success: false, reason: 'Table not found' };

        const tbody = table.children[0];
        if (!tbody) return { success: false, reason: 'Tbody not found' };

        const secondRow = tbody.children[1]; // Second row (first is header)
        if (!secondRow) return { success: false, reason: 'Second row not found' };

        const secondCell = secondRow.children[1]; // Second cell
        if (!secondCell) return { success: false, reason: 'Second cell not found' };

        // Simulate mousedown/mouseup to select cell
        const rect = secondCell.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        const mousedown = new MouseEvent('mousedown', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0
        });

        const mouseup = new MouseEvent('mouseup', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0
        });

        secondCell.dispatchEvent(mousedown);
        secondCell.dispatchEvent(mouseup);

        // Wait for edit mode to activate
        await new Promise(resolve => setTimeout(resolve, 500));

        // Find and set the hidden input field value
        const input = document.getElementById('jsgrid_editbox') as HTMLInputElement;
        if (!input) return { success: false, reason: 'jsgrid_editbox input not found' };

        // Focus the input first
        input.focus();

        // Set the value
        input.value = val;

        // Trigger input event
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

        // Trigger keyup event (some grids need this)
        const keyupEvent = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: val.charAt(val.length - 1) });
        input.dispatchEvent(keyupEvent);

        return { success: true, reason: `Set input value to "${val}"`, inputValue: input.value };
      }, value);

      logs.push(`✅ Attempt ${attempt}: ${result.reason}`);
      return result;
    };

    // Run the set value operation TWICE (as discovered in manual testing)
    const result1 = await setCellValue(hours, 1);
    if (!result1.success) {
      return { success: false, message: `${logs.join('\n')}\n❌ First attempt failed: ${result1.reason}` };
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const result2 = await setCellValue(hours, 2);
    if (!result2.success) {
      return { success: false, message: `${logs.join('\n')}\n❌ Second attempt failed: ${result2.reason}` };
    }

    logs.push('✅ Value set successfully after 2 attempts');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 14: Click Save button
    logs.push('🔍 Clicking Save button...');
    const saveButton = await page.$('a[id*="Save-Large"]');
    if (saveButton) {
      await saveButton.click();
      logs.push('✅ Clicked Save button');
    } else {
      return { success: false, message: `${logs.join('\n')}\n❌ Could not find Save button` };
    }

    // Wait for save to complete
    await new Promise(resolve => setTimeout(resolve, 3000));

    return { success: true, message: `${logs.join('\n')}\n\n✅ Timesheet submitted successfully!` };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // Helper method to inspect the page structure
  async inspectPageStructure(): Promise<string> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();

    try {
      await this.authenticate(page);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get all form elements and grid information
      const pageInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          class: input.className
        }));

        const textareas = Array.from(document.querySelectorAll('textarea')).map(textarea => ({
          name: textarea.name,
          id: textarea.id,
          class: textarea.className
        }));

        const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')).map(button => ({
          text: button.textContent || (button as HTMLInputElement).value,
          id: button.id,
          class: button.className,
          name: (button as HTMLInputElement).name
        }));

        // Try to find grid objects
        const w = window as any;
        const gridInfo: any = {
          found: false,
          gridVariables: []
        };

        // Check for common SharePoint grid variable names
        const gridVarNames = ['idGrid', 'g_grid', 'pwaGrid', 'tsGrid', 'timesheetGrid'];
        for (const varName of gridVarNames) {
          if (w[varName]) {
            gridInfo.found = true;
            gridInfo.gridVariables.push({
              name: varName,
              type: typeof w[varName],
              methods: Object.getOwnPropertyNames(Object.getPrototypeOf(w[varName])).filter(
                name => typeof w[varName][name] === 'function'
              ).slice(0, 50), // Limit to first 50 methods
              properties: Object.keys(w[varName]).slice(0, 20) // Limit to first 20 properties
            });
          }
        }

        // Look for any grid-related elements in the DOM
        const gridElements = Array.from(document.querySelectorAll('[id*="grid"], [id*="Grid"], [class*="grid"], [class*="Grid"]')).map(el => ({
          id: el.id,
          tagName: el.tagName,
          className: el.className
        })).slice(0, 10);

        return {
          inputs,
          textareas,
          buttons,
          gridInfo,
          gridElements
        };
      });

      return JSON.stringify({
        pageTitle: await page.title(),
        pageUrl: page.url(),
        formElements: {
          inputs: pageInfo.inputs,
          textareas: pageInfo.textareas,
          buttons: pageInfo.buttons
        },
        gridInformation: pageInfo.gridInfo,
        gridElements: pageInfo.gridElements
      }, null, 2);
    } finally {
      await page.close();
    }
  }
}
