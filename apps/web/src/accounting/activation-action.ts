import type { ReactNode } from 'react';
import type { OpeningReview } from '@/accounting/types';

/**
 * PR 9 adds the enable control here. The review stays read-only until then.
 */
export function activationAction(review: OpeningReview): ReactNode {
  if (review.canActivate) return null;
  return null;
}
