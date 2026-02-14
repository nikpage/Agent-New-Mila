import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Capture a test message
    Sentry.captureMessage('Sentry test from API route', 'info');

    // Throw a test error
    throw new Error('This is a test error to verify Sentry is working');
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      {
        success: true,
        message: 'Test error sent to Sentry. Check your Sentry dashboard at https://sentry.io'
      },
      { status: 200 }
    );
  }
}
