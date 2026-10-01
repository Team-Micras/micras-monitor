import { describe, expect, test } from 'vitest';

import type { CommandSpec, EnumType } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';

import {
  acceptedStatesText,
  commandAvailability,
  outcomeMessage,
} from '@/app/windows/commands/command-state';

const STATE: EnumType = {
  kind: 'enum',
  name: 'State',
  options: [
    { value: 0, label: 'IDLE' },
    { value: 1, label: 'RUN' },
  ],
};
const GO: CommandSpec = { code: 0, name: 'GO', label: 'Go', acceptedIn: [0] };
const STOP: CommandSpec = {
  code: 5,
  name: 'STOP',
  label: 'Stop',
  acceptedIn: 'any',
  emergency: true,
};
const context = { linked: true, state: 0, stateLabels: STATE, inFlight: false };

describe('commandAvailability', () => {
  test('is disabled without a link, whatever the state', () => {
    expect(commandAvailability(GO, { ...context, linked: false })).toEqual({
      enabled: false,
      hint: 'accepted',
      reason: 'Not connected to a robot',
    });
  });

  test('is disabled while the command waits for its answer', () => {
    expect(commandAvailability(GO, { ...context, inFlight: true })).toMatchObject({
      enabled: false,
      reason: 'Waiting for the robot to answer',
    });
  });

  test('only hints when the state is not one the table accepts, and lets the robot answer', () => {
    expect(commandAvailability(GO, { ...context, state: 1 })).toEqual({
      enabled: true,
      hint: 'not-accepted',
      reason: 'Needs IDLE; the robot is in RUN',
    });
    expect(commandAvailability(GO, context)).toEqual({
      enabled: true,
      hint: 'accepted',
      reason: null,
    });
    expect(commandAvailability(GO, { ...context, state: null })).toMatchObject({ hint: 'unknown' });
    expect(commandAvailability(STOP, { ...context, state: 1 })).toMatchObject({ hint: 'accepted' });
  });
});

describe('acceptedStatesText', () => {
  test('names the states by their labels', () => {
    expect(acceptedStatesText(GO, STATE)).toBe('IDLE');
    expect(acceptedStatesText(GO, null)).toBe('0');
    expect(acceptedStatesText(STOP, STATE)).toBe('any state');
  });
});

describe('outcomeMessage', () => {
  const pkg = mouse();

  test('gives a refusal its reason from the package', () => {
    expect(outcomeMessage(GO, { status: 'refused', reason: 1 }, pkg, STATE)).toEqual({
      tone: 'refused',
      title: 'Refused — not idle',
      detail: 'Go is accepted in IDLE.',
    });
    expect(outcomeMessage(GO, { status: 'refused', reason: 9 }, pkg).title).toBe(
      'Refused — no reason given'
    );
  });

  test('reads acceptance, deferral, unknown commands and failures', () => {
    expect(outcomeMessage(GO, { status: 'ok', reason: 0 }, pkg).tone).toBe('ok');
    expect(outcomeMessage(GO, { status: 'deferred', reason: 0 }, pkg).title).toBe('Go deferred');
    expect(outcomeMessage(GO, { status: 'unknown', reason: null }, pkg).tone).toBe('refused');
    expect(outcomeMessage(GO, { status: 'failed', message: 'No link.' }, pkg)).toEqual({
      tone: 'failed',
      title: 'Go not sent',
      detail: 'No link.',
    });
  });
});
