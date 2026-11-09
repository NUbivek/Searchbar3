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
import { tavusMark, tavusDebugEnabled } from './debug';

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

    const onStarted = (e) => {
      tavusMark('conversation-started', { conversationId: e?.detail?.conversationId });
      liveRef.current = true;
      const r = routerRef.current;
      lastPageRef.current = describePage(r.pathname, r.query);
    };
    const onEnded = (e) => { tavusMark('conversation-ended', { conversationId: e?.detail?.conversationId }); liveRef.current = false; };

    const onToolCall = (e) => {
      const { name, arguments: rawArguments, tool_call_id: toolCallId } = e.detail || {};
      tavusMark('tool-call received', { name, toolCallId });
      const plan = planToolCall(name, rawArguments);
      tavusMark('tool-call validated', { name, toolCallId, ok: !plan.error });
      const reply = (status, output) => {
        tavusMark('tool_result sent', { name, toolCallId, status, paired: Boolean(toolCallId) });
        if (!toolCallId) return; // nothing to pair a reply with: just act
        integration.sendMessage({ event_type: 'conversation.tool_result', properties: { tool_call_id: toolCallId, status, output } });
      };
      if (plan.error) { reply('error', plan.error); return; }
      routerRef.current.push(plan.href, undefined, { scroll: true })
        .then(() => reply('success', plan.say))
        .catch(() => reply('error', 'The page could not be opened.'));
    };

    // Debug only: speaking and utterance events, to see where a stall sits.
    const onProtocol = (e) => {
      const d = e.detail || {};
      const type = d.event_type || d.kind;
      if (!/utterance|speaking|tool_call|interrupt/.test(String(type || ''))) return;
      if (type === 'conversation.utterance' && typeof d.properties?.final === 'boolean') return; // skip streaming partials
      tavusMark(type, { role: d.properties?.role });
    };
    const onState = (e) => tavusMark('state', { state: e.detail?.state });
    const onError = (e) => tavusMark('error', { code: e.detail?.code });
    const debug = tavusDebugEnabled();
    if (debug) {
      integration.on('tavus:protocol-message', onProtocol);
      integration.on('tavus:state-change', onState);
      integration.on('tavus:error', onError);
    }

    integration.on('tavus:conversation-started', onStarted);
    integration.on('tavus:conversation-ended', onEnded);
    integration.on('tavus:tool-call', onToolCall);
    return () => {
      integration.off('tavus:conversation-started', onStarted);
      integration.off('tavus:conversation-ended', onEnded);
      integration.off('tavus:tool-call', onToolCall);
      if (debug) {
        integration.off('tavus:protocol-message', onProtocol);
        integration.off('tavus:state-change', onState);
        integration.off('tavus:error', onError);
      }
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
