/**
 * The Tavus guide agent: one floating <tavus-widget> for the whole app
 * (mounted once in _app.js so a call survives client-side navigation).
 *
 * - Tells the agent where the visitor is: `conversational-context` before a
 *   call; `conversation.append_llm_context` on every route change during one.
 * - Lets the agent act on the page through PAL tools (see guideTools.js):
 *   it navigates with the Next.js router (never a full page load, which would
 *   end the call) and replies with `conversation.tool_result`.
 *
 * Browser-only: _app.js loads this file with next/dynamic and ssr: false.
 */
import React, { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import '@tavus/widget';
import { TavusIntegration } from '@tavus/widget';
import { TAVUS_DEPLOYMENT_ID } from '../../config/tavus';
import { describePage, initialContext, planToolCall } from './guideTools';

export default function TavusGuide() {
  const router = useRouter();
  const integrationRef = useRef(null);
  const liveRef = useRef(false);
  const lastPageRef = useRef('');
  const routerRef = useRef(router);
  routerRef.current = router;

  // Wire events once, right after the element is in the DOM.
  useEffect(() => {
    if (!TAVUS_DEPLOYMENT_ID) return undefined;
    const integration = new TavusIntegration('tavus-widget');
    integrationRef.current = integration;

    const onStarted = () => {
      liveRef.current = true;
      const r = routerRef.current;
      lastPageRef.current = describePage(r.pathname, r.query);
    };
    const onEnded = () => { liveRef.current = false; };

    const onToolCall = (e) => {
      const { name, arguments: rawArguments, tool_call_id: toolCallId } = e.detail || {};
      const plan = planToolCall(name, rawArguments);
      const reply = (status, output) => {
        if (!toolCallId) return; // nothing to pair a reply with: just act
        integration.sendMessage({ event_type: 'conversation.tool_result', properties: { tool_call_id: toolCallId, status, output } });
      };
      if (plan.error) { reply('error', plan.error); return; }
      routerRef.current.push(plan.href, undefined, { scroll: true })
        .then(() => reply('success', plan.say))
        .catch(() => reply('error', 'The page could not be opened.'));
    };

    integration.on('tavus:conversation-started', onStarted);
    integration.on('tavus:conversation-ended', onEnded);
    integration.on('tavus:tool-call', onToolCall);
    return () => {
      integration.off('tavus:conversation-started', onStarted);
      integration.off('tavus:conversation-ended', onEnded);
      integration.off('tavus:tool-call', onToolCall);
    };
  }, []);

  // During a call, tell the agent when the page or the current query changes.
  const pageNow = describePage(router.pathname, router.query);
  useEffect(() => {
    if (!liveRef.current || !integrationRef.current || pageNow === lastPageRef.current) return;
    lastPageRef.current = pageNow;
    integrationRef.current.sendMessage({ event_type: 'conversation.append_llm_context', properties: { context: `Update: ${pageNow}` } });
  }, [pageNow]);

  if (!TAVUS_DEPLOYMENT_ID) return null;
  return (
    <tavus-widget
      deployment-id={TAVUS_DEPLOYMENT_ID}
      conversational-context={initialContext(router.pathname, router.query)}
    />
  );
}
