/**
 * Privacy policy. Plain page; linked from the footer and from the Google
 * sign-in consent configuration.
 */
import React from 'react';
import Link from 'next/link';
import PageShell from '../components/layout/PageShell';

const UPDATED = 'November 8, 2026';

export default function PrivacyPage() {
  return (
    <PageShell title="Privacy policy" subtitle={`Last updated ${UPDATED}`}>
      <div className="card card-pad prose-sm max-w-3xl space-y-5 text-sm text-slate-700">
        <section>
          <h2 className="text-base font-semibold text-ink">What we collect</h2>
          <p className="mt-1">
            When you sign in with Google we store your name, email address and profile picture so we can
            recognise your account. We also store what you create in the app: searches and their results,
            workspaces, notes, documents you upload, watchlist entries and any network contacts you import.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">How we use it</h2>
          <p className="mt-1">
            Your data is used only to run the product for you: to show your history, keep your workspaces,
            run watchlist checks you asked for and match founders against the network you imported. We do not
            sell your data, share it with advertisers or use it to train models.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Your network</h2>
          <p className="mt-1">
            Contacts you import are private to your account. They are never shown to other users, never posted
            anywhere and never sent to third parties. Deleting your network removes every imported contact.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Third-party services</h2>
          <p className="mt-1">
            Search queries are sent to web search and language-model providers to produce answers. Those
            requests contain the text of your query and public search results, never your contacts or account
            details. Google handles sign-in; we never see your Google password.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Retention and deletion</h2>
          <p className="mt-1">
            Data is kept while your account exists. You can delete searches, workspaces, watchlist items and
            your network from inside the app at any time. To delete your account entirely, email the address
            below and we will remove everything within 30 days.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-ink">Contact</h2>
          <p className="mt-1">
            Questions about this policy: <a className="text-brand-600 hover:underline" href="mailto:hi@bivek.ai">hi@bivek.ai</a>.
            See also the <Link href="/terms" className="text-brand-600 hover:underline">terms of service</Link>.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
