/**
 * @file public/replay-core.js
 * @description Reconstruct Maze Bench movement paths from public results
 */

(function registerMazeReplayCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.MazeReplayCore = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createMazeReplayCore() {
  "use strict";

  const i18n = globalThis.MazeBenchI18n;
  const DIRECTIONS = ["N", "E", "S", "W"];
  const DIRECTION_VECTORS = {
    N: [0, -1],
    E: [1, 0],
    S: [0, 1],
    W: [-1, 0],
  };
  const RELATIVE_TURNS = {
    S: 0,
    R: 1,
    B: 2,
    L: 3,
  };

  /** @description Create an error that can be translated again after a locale change */
  function _error(key, parameters, fallback) {
    const error = new Error(i18n?.t(key, parameters) ?? fallback);
    error.translationKey = key;
    error.translationParameters = parameters;
    return error;
  }

  /** @description Parse commands with the same word rules as the Python scorer */
  function parseActions(text) {
    const actions = [];
    const words = String(text ?? "").toUpperCase().match(/[A-Z]+/g) ?? [];

    for (const word of words) {
      if ([...word].every((character) => Object.hasOwn(RELATIVE_TURNS, character))) {
        actions.push(...word);
      }
    }
    return actions;
  }

  /** @description Convert a relative command to an absolute direction */
  function rotateDirection(facing, action) {
    const facingIndex = DIRECTIONS.indexOf(facing);
    if (facingIndex < 0 || !Object.hasOwn(RELATIVE_TURNS, action)) {
      throw _error(
        "replay.directionError",
        { facing, action },
        `방향을 변환할 수 없습니다: ${facing}, ${action}`,
      );
    }
    return DIRECTIONS[(facingIndex + RELATIVE_TURNS[action]) % DIRECTIONS.length];
  }

  /** @description Return the SVG point for an event, including outside events */
  function eventPoint(maze, eventId) {
    if (eventId === "START_OUT") {
      return outsidePoint(maze.start_cell, maze.start_side);
    }
    if (eventId === "GOAL_OUT") {
      return outsidePoint(maze.goal_cell, maze.goal_side);
    }

    const event = maze.events[eventId];
    if (!event || !Array.isArray(event.cell)) {
      throw _error(
        "replay.eventPointError",
        { event: eventId },
        `미로 이벤트 좌표가 없습니다: ${eventId}`,
      );
    }
    return [event.cell[0] + 0.5, event.cell[1] + 0.5];
  }

  /** @description Return the point used for an outside start or goal arrow */
  function outsidePoint(cell, side) {
    const vector = DIRECTION_VECTORS[side];
    if (!Array.isArray(cell) || !vector) {
      throw _error(
        "replay.outsidePointError",
        { side },
        `외부 지점 정보를 해석할 수 없습니다: ${side}`,
      );
    }
    return [
      cell[0] + 0.5 + vector[0] * 1.15,
      cell[1] + 0.5 + vector[1] * 1.15,
    ];
  }

  /** @description Locate the wall hit by an invalid movement */
  function collisionPoint(maze, eventId, absoluteDirection) {
    const vector = DIRECTION_VECTORS[absoluteDirection];
    if (!vector) {
      throw _error(
        "replay.collisionPointError",
        { direction: absoluteDirection },
        `충돌 방향을 해석할 수 없습니다: ${absoluteDirection}`,
      );
    }

    if (eventId === "START_OUT") {
      const point = eventPoint(maze, eventId);
      return [point[0] + vector[0] * 0.45, point[1] + vector[1] * 0.45];
    }

    const point = eventPoint(maze, eventId);
    return [point[0] + vector[0] * 0.5, point[1] + vector[1] * 0.5];
  }

  /**
   * @description Reconstruct every executable segment and terminal command
   * @param {object} maze Parsed maze JSON
   * @param {string|string[]} output Raw model output or parsed actions
   * @returns {object} Replay data
   */
  function simulateReplay(maze, output) {
    const actions = Array.isArray(output)
      ? output.map((action) => String(action).toUpperCase())
      : parseActions(output);
    const segments = [];
    let currentEvent = "START_OUT";
    let facing = maze.initial_facing;
    let collision = null;
    let successIndex = null;

    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      const absoluteDirection = rotateDirection(facing, action);
      const available = maze.transitions[currentEvent] ?? {};
      const edge = available[absoluteDirection];

      if (!edge) {
        const from = eventPoint(maze, currentEvent);
        collision = {
          index,
          action,
          absoluteDirection,
          eventId: currentEvent,
          from,
          point: collisionPoint(maze, currentEvent, absoluteDirection),
        };
        break;
      }

      const nextEvent = edge.to;
      segments.push({
        index,
        action,
        absoluteDirection,
        fromEvent: currentEvent,
        toEvent: nextEvent,
        from: eventPoint(maze, currentEvent),
        to: eventPoint(maze, nextEvent),
        goal: nextEvent === "GOAL_OUT",
      });
      currentEvent = nextEvent;
      facing = absoluteDirection;

      if (currentEvent === "GOAL_OUT") {
        successIndex = index;
        break;
      }
    }

    const terminalCursor = collision
      ? collision.index + 1
      : successIndex !== null
        ? successIndex + 1
        : actions.length;

    return {
      actions,
      segments,
      collision,
      successIndex,
      terminalCursor,
      successfulMoves: segments.length,
      finalEvent: currentEvent,
      finalFacing: facing,
      finalPoint: eventPoint(maze, currentEvent),
    };
  }

  return {
    DIRECTION_VECTORS,
    DIRECTIONS,
    collisionPoint,
    eventPoint,
    outsidePoint,
    parseActions,
    rotateDirection,
    simulateReplay,
  };
}));
