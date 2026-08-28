import type { Locator } from '../../automation/types.js';
import type { ControlDescriptor } from '../../types.js';
import {
  overlayBaseline,
  waitForOverlay,
  waitForOverlayContent,
} from '../overlay.js';
import type { HandlerContext, OpenResult } from './types.js';

/**
 * Clicks whatever this control kind's trigger is and waits for its
 * overlay/picker to appear — the "open" half of select/date/valueHelp/
 * multiSelect, kept apart from the handlers so Manual mode can reuse exactly
 * this and stop there, instead of also auto-picking a value the way the
 * handlers do.
 */
export async function openControlOverlay(
  control: ControlDescriptor,
  ctx: HandlerContext,
  loc: Locator,
  selector: string,
): Promise<OpenResult> {
  const baseline = await overlayBaseline(ctx.page);

  switch (control.kind) {
    case 'select': {
      // A native <select> renders its list in the operating system's own
      // layer, which cannot be screenshotted or driven the same way.
      const isNative = await loc
        .evaluate((el: Element) => el.tagName === 'SELECT')
        .catch(() => false);
      if (isNative) return { opened: false, baseline, isNative: true };

      await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      return { opened, baseline };
    }

    case 'multiSelect': {
      const arrow = ctx.page.locator(`${selector} .sapMInputBaseIconContainer`).first();
      if (await arrow.isVisible().catch(() => false)) {
        await arrow.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }
      const opened = await waitForOverlay(ctx.page, 3000, baseline);
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'valueHelp': {
      const trigger = ctx.page
        .locator(
          `${selector} .sapMInputValHelp, ${selector} .sapMInputValHelpInner, ` +
            `${selector} .sapUiIcon`,
        )
        .first();

      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }

      const opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );
      if (opened) await waitForOverlayContent(ctx.page, ctx.budgets.controlTimeoutMs, baseline);
      return { opened, baseline };
    }

    case 'date':
    case 'dateRange': {
      const icon = ctx.page.locator(`${selector} .sapUiIcon`).first();
      if (await icon.isVisible().catch(() => false)) {
        await icon.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      } else {
        await loc.click({ timeout: ctx.budgets.controlTimeoutMs }).catch(() => undefined);
      }

      let opened = await waitForOverlay(
        ctx.page,
        Math.min(ctx.budgets.controlTimeoutMs, 8000),
        baseline,
      );

      // See the long-standing note on this fallback: F4 is UI5's own
      // theme/version-independent "open this control's picker" convention.
      if (!opened) {
        await loc.focus().catch(() => undefined);
        await ctx.page.keyboard.press('F4').catch(() => undefined);
        opened = await waitForOverlay(
          ctx.page,
          Math.min(ctx.budgets.controlTimeoutMs, 8000),
          baseline,
        );
      }
      return { opened, baseline };
    }

    default:
      return { opened: false, baseline };
  }
}
