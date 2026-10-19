import { useMemo, useState } from 'react';
import { AlertIcon, WarningIcon } from '@/components/icons';
import { Button } from '@/components/primitives/Button';
import { TextField } from '@/components/primitives/TextField';
import { useAsyncState } from '@/hooks/useAsyncState';
import type { ChatRequest, ChatThread } from '@/lib/agentChat';
import type { ChatResponse } from '@/lib/agentChat';
import { interruptAgentChatThread, respondToAgentChatRequest } from '@/lib/agentChatStore';

interface AgentChatRequestCardProps {
  projectPath: string;
  threadId: string;
  request: ChatRequest;
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionField {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  isOther: boolean;
  isSecret: boolean;
}

const PLAIN_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const;
const PLAIN_DECISION_SET = new Set<string>(PLAIN_DECISIONS);
const AMENDMENT_DECISIONS = [
  'acceptWithExecpolicyAmendment',
  'applyNetworkPolicyAmendment',
] as const;
const AMENDMENT_DECISION_SET = new Set<string>(AMENDMENT_DECISIONS);

interface ApprovalDecision {
  id: string;
  label: string;
  allowsAction: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readQuestions(params: Record<string, unknown>): QuestionField[] {
  if (!Array.isArray(params.questions)) return [];
  return params.questions.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const question = value as Record<string, unknown>;
    if (typeof question.id !== 'string' || typeof question.question !== 'string') return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const candidate = option as Record<string, unknown>;
          if (typeof candidate.label !== 'string') return [];
          return [
            { label: candidate.label, description: asString(candidate.description) || undefined },
          ];
        })
      : [];
    return [
      {
        id: question.id,
        header: asString(question.header),
        question: question.question,
        options,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
      },
    ];
  });
}

function readApprovalDecisions(request: ChatRequest): ApprovalDecision[] {
  const offered = request.params.availableDecisions;
  if (request.method === 'execCommandApproval' || request.method === 'applyPatchApproval') {
    const legacy = ['approved', 'approved_for_session', 'abort'];
    const values = Array.isArray(offered)
      ? offered.filter(
          (decision): decision is (typeof legacy)[number] =>
            typeof decision === 'string' && legacy.includes(decision)
        )
      : legacy;
    return values.map((id) => ({
      id,
      label:
        id === 'approved'
          ? 'Allow'
          : id === 'approved_for_session'
            ? 'Allow this session'
            : 'Decline',
      allowsAction: id !== 'abort',
    }));
  }
  if (Array.isArray(offered)) {
    const values: ApprovalDecision[] = [];
    const decisions: unknown[] = offered;
    for (const decision of decisions) {
      if (
        typeof decision === 'string' &&
        (PLAIN_DECISION_SET.has(decision) || AMENDMENT_DECISION_SET.has(decision))
      ) {
        values.push({
          id: decision,
          label: amendmentDecisionLabel(decision),
          allowsAction: decision !== 'decline' && decision !== 'cancel',
        });
        continue;
      }
      if (!decision || typeof decision !== 'object') continue;
      for (const key of Object.keys(decision)) {
        if (!AMENDMENT_DECISION_SET.has(key)) continue;
        values.push({ id: key, label: amendmentDecisionLabel(key), allowsAction: true });
      }
    }
    return values;
  }
  return [
    { id: 'accept', label: 'Allow', allowsAction: true },
    { id: 'decline', label: 'Decline', allowsAction: false },
  ];
}

function amendmentDecisionLabel(decision: string): string {
  if (decision === 'acceptWithExecpolicyAmendment') return 'Allow with policy update';
  if (decision === 'applyNetworkPolicyAmendment') return 'Allow with network access';
  if (decision === 'accept' || decision === 'approved') return 'Allow';
  if (decision === 'acceptForSession' || decision === 'approved_for_session')
    return 'Allow this session';
  if (decision === 'decline' || decision === 'abort') return 'Decline';
  return 'Cancel';
}

function stringParam(params: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof params[key] === 'string' && params[key].trim()) return params[key];
  }
  return null;
}

export function AgentChatRequestCard({
  projectPath,
  threadId,
  request,
}: AgentChatRequestCardProps) {
  const questions = useMemo(() => readQuestions(request.params), [request.params]);
  const rawQuestions = request.params.questions;
  const questionsSupported =
    Array.isArray(rawQuestions) &&
    rawQuestions.length > 0 &&
    questions.length === rawQuestions.length;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const {
    execute: respond,
    isLoading,
    error,
  } = useAsyncState<ChatThread, [ChatResponse]>(async (response) =>
    respondToAgentChatRequest(projectPath, threadId, request.id, response)
  );
  const { execute: stopTurn, error: stopError } = useAsyncState<ChatThread, [string]>((id) =>
    interruptAgentChatThread(projectPath, id)
  );

  const updateAnswer = (id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: value }));
  };

  const sendDecision = (decision: string) => {
    void respond(request.kind === 'elicitation' ? { action: decision } : { decision });
  };

  const submitAnswers = () => {
    if (!questionsSupported) return;
    const answerPayload: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const selected = answers[question.id] ?? '';
      const value = selected === '__other__' ? (otherAnswers[question.id] ?? '') : selected;
      if (!value.trim()) return;
      answerPayload[question.id] = { answers: [value.trim()] };
    }
    void respond({ answers: answerPayload });
  };

  const command = stringParam(request.params, 'command');
  const requestLabel =
    (request.kind === 'approval' && command ? 'Command approval' : request.title) ||
    (request.kind === 'approval'
      ? 'Approval requested'
      : request.kind === 'question'
        ? 'Codex has a question'
        : 'Interactive request');
  const reason = stringParam(request.params, 'reason', 'message');
  const cwd = stringParam(request.params, 'cwd');
  const approvalDecisions = readApprovalDecisions(request);
  const safeDeclineAvailable = approvalDecisions.some((decision) =>
    ['decline', 'cancel', 'abort'].includes(decision.id)
  );

  return (
    <section className="agent-chat-request" aria-label={requestLabel} data-kind={request.kind}>
      <header className="agent-chat-request__header">
        {request.kind === 'approval' ? <WarningIcon size={16} /> : <AlertIcon size={16} />}
        <div className="agent-chat-request__title-wrap">
          <strong>{requestLabel}</strong>
          <span>{request.kind === 'approval' ? 'Review this action' : 'Response needed'}</span>
        </div>
      </header>

      {request.kind === 'approval' && (
        <div className="agent-chat-request__details">
          {command && (
            <pre className="agent-chat-request__command">
              <code>{command}</code>
            </pre>
          )}
          {reason && <p className="agent-chat-request__reason">{reason}</p>}
          {cwd && (
            <p className="agent-chat-request__context">
              Working directory: <code>{cwd}</code>
            </p>
          )}
          {!reason && !command && !cwd && (
            <p>Codex is waiting for approval to continue with this action.</p>
          )}
          {approvalDecisions.length === 0 && (
            <p>
              Codex offered an approval shape this panel cannot answer. Stop this turn to leave the
              request safely.
            </p>
          )}
          {approvalDecisions.length > 0 && !safeDeclineAvailable && (
            <p>This request has no decline option. Stop the turn to reject it safely.</p>
          )}
        </div>
      )}

      {request.kind === 'question' && (
        <div className="agent-chat-request__questions">
          {!questionsSupported ? (
            <p>
              This question format is not available in chat. Stop this turn or switch to Terminal to
              answer it.
            </p>
          ) : (
            questions.map((question) => {
              const selected = answers[question.id] ?? '';
              return (
                <label className="agent-chat-question" key={question.id}>
                  {question.header && (
                    <span className="agent-chat-question__header">{question.header}</span>
                  )}
                  <span className="agent-chat-question__prompt">{question.question}</span>
                  {question.options.length > 0 ? (
                    <select
                      className="agent-chat-select"
                      value={selected}
                      onChange={(event) => updateAnswer(question.id, event.target.value)}
                    >
                      <option value="">Choose an answer</option>
                      {question.options.map((option) => (
                        <option key={option.label} value={option.label}>
                          {option.description
                            ? `${option.label} — ${option.description}`
                            : option.label}
                        </option>
                      ))}
                      {question.isOther && <option value="__other__">Other</option>}
                    </select>
                  ) : (
                    <TextField
                      type={question.isSecret ? 'password' : 'text'}
                      value={selected}
                      placeholder="Your answer"
                      onChange={(event) => updateAnswer(question.id, event.target.value)}
                    />
                  )}
                  {question.isOther && selected === '__other__' && (
                    <TextField
                      type={question.isSecret ? 'password' : 'text'}
                      value={otherAnswers[question.id] ?? ''}
                      placeholder="Enter your answer"
                      onChange={(event) =>
                        setOtherAnswers((current) => ({
                          ...current,
                          [question.id]: event.target.value,
                        }))
                      }
                    />
                  )}
                </label>
              );
            })
          )}
        </div>
      )}

      {request.kind === 'elicitation' && (
        <div className="agent-chat-request__details">
          <p>
            This interactive form cannot be completed in chat yet. Decline the request or cancel it
            here.
          </p>
          {reason && <p className="agent-chat-request__context">{reason}</p>}
        </div>
      )}

      {error && (
        <p className="agent-chat-request__error" role="alert">
          {error.message}
        </p>
      )}
      {stopError && (
        <p className="agent-chat-request__error" role="alert">
          {stopError.message}
        </p>
      )}

      <footer className="agent-chat-request__actions">
        {request.kind === 'approval' &&
          approvalDecisions.map((decision) => (
            <Button
              key={decision.id}
              size="compact"
              variant={decision.allowsAction ? 'primary' : 'secondary'}
              disabled={isLoading}
              onClick={() => sendDecision(decision.id)}
            >
              {decision.label}
            </Button>
          ))}

        {request.kind === 'approval' && !safeDeclineAvailable && (
          <Button
            size="compact"
            variant="danger"
            disabled={isLoading}
            onClick={() => void stopTurn(threadId)}
          >
            Stop turn
          </Button>
        )}

        {request.kind === 'question' && questionsSupported && (
          <Button size="compact" variant="primary" disabled={isLoading} onClick={submitAnswers}>
            {isLoading ? 'Sending…' : 'Send answer'}
          </Button>
        )}
        {request.kind === 'question' && !questionsSupported && (
          <span className="agent-chat-request__unsupported">
            No supported answer format was returned.
          </span>
        )}

        {request.kind === 'elicitation' && (
          <>
            <Button
              size="compact"
              variant="secondary"
              disabled={isLoading}
              onClick={() => sendDecision('cancel')}
            >
              Cancel request
            </Button>
            <Button
              size="compact"
              variant="secondary"
              disabled={isLoading}
              onClick={() => sendDecision('decline')}
            >
              Decline
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}
