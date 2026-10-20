/**
 * Window events that open the account sheets and first-run setup from
 * anywhere (the chat model switcher, Preferences, New Chat → Remote).
 *
 *   window.dispatchEvent(new CustomEvent('vmlx:connect-account', { detail: { account: 'deepseek' } }))
 *
 * `account`: a featured account id ('deepseek' | 'anthropic' | 'openai' |
 * 'google' | 'wavespeed'), 'custom' for the Custom endpoint sheet, or 'list'
 * (or no `account` at all) for the sheet that lists all five.
 */
import type { FeaturedAccountId } from '../../../../shared/curated'

export const CONNECT_ACCOUNT_EVENT = 'vmlx:connect-account'
export const ONBOARDING_EVENT = 'vmlx:onboarding'

export type ConnectAccountTarget = FeaturedAccountId | 'custom' | 'list'

export function openConnectAccount(account: ConnectAccountTarget): void {
  window.dispatchEvent(new CustomEvent(CONNECT_ACCOUNT_EVENT, { detail: { account } }))
}

export function openOnboarding(): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT))
}
