/**
 * Terms of service. Plain page; linked from the footer and from the Google
 * sign-in consent configuration.
 */
import React from 'react';
import Link from 'next/link';
import PageShell from '../components/layout/PageShell';

const UPDATED = 'November 8, 2026';

export default function TermsPage() {
  return (
    <PageShell title="Terms of service" subtitle={`Last updated ${UPDATED}`}>
      <div className="card card-pad max-w-3xl space-y-5 text-sm text-slate-700">
        <section>
          <h2 className="text-base font-semibold text-ink">The service</h2>
          <p className="mt-1">
            Research Hub produces research summaries, founder background checks and network matches from
            public sources. Every figure is cited to the source it came from so you can verify it yourself.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">No advice</h2>
          <p className="mt-1">
            Output is information, not investment, legal or professional advice. Sources can be wrong,
            outdated or incomplete, and automated extraction can misread them. Check the cited sources before
            relying on anything, and make your own decisions.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Your account</h2>
          <p className="mt-1">
            You sign in with a Google account and are responsible for activity under it. Do not use the
            service to harass anyone, to collect personal data you are not entitled to hold, or in breach of
            any law. We may suspend accounts used that way.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Your content</h2>
          <p className="mt-1">
            You keep ownership of notes, documents and contacts you add. You confirm you have the right to
            upload them. We only use them to provide the service to you, as described in the{' '}
            <Link href="/privacy" className="text-brand-600 hover:underline">privacy policy</Link>.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Availability and changes</h2>
          <p className="mt-1">
            The service is provided as is, without warranty, and may change or pause without notice. We may
            update these terms; continued use after a change means you accept the new terms.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Contact</h2>
          <p className="mt-1">
            Questions: <a className="text-brand-600 hover:underline" href="mailto:hi@bivek.ai">hi@bivek.ai</a>.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
