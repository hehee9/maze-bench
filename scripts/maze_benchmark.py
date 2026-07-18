from __future__ import annotations

import argparse
import json
import math
import random
import re
import secrets
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None
    ImageDraw = None


# ---------------------------------------------------------------------------
# Directions and actions
# ---------------------------------------------------------------------------

DIRS: Dict[str, Tuple[int, int]] = {
    "N": (0, -1),
    "E": (1, 0),
    "S": (0, 1),
    "W": (-1, 0),
}
DIR_TO_INT = {"N": 0, "E": 1, "S": 2, "W": 3}
INT_TO_DIR = {value: key for key, value in DIR_TO_INT.items()}
OPPOSITE = {"N": "S", "E": "W", "S": "N", "W": "E"}
VALID_SIDES = tuple("NESW")

# Relative to the player's current facing.
# S = straight, R = right, B = back, L = left.
REL_TO_DELTA = {"S": 0, "R": 1, "B": 2, "L": 3}
DELTA_TO_REL = {value: key for key, value in REL_TO_DELTA.items()}
VALID_ACTIONS = frozenset(REL_TO_DELTA)

START_OUT = "START_OUT"
GOAL_OUT = "GOAL_OUT"
SCORING_VERSION = 3
STRICT_ACTIONS = re.compile(
    r"^\s*[SRBL](?:\s+[SRBL])*\s*$",
    re.IGNORECASE,
)
CODE_FENCE_LANGUAGES = {"text", "plaintext"}

Cell = Tuple[int, int]
CellOrOutside = Union[Cell, str]


class MazeError(Exception):
    """Raised when a generated or loaded maze violates benchmark invariants."""


def normalize_action_response(response_text: str) -> str:
    """Remove one supported outer code wrapper from a command response."""
    candidate = response_text.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        if candidate.count("```") != 2:
            return candidate
        fenced = candidate[3:-3]
        if "```" in fenced:
            return candidate
        first_line, separator, remainder = fenced.partition("\n")
        normalized_first_line = first_line.rstrip("\r").strip().lower()
        if separator and normalized_first_line in CODE_FENCE_LANGUAGES:
            return remainder.strip()
        if separator and normalized_first_line and not STRICT_ACTIONS.fullmatch(
            first_line
        ):
            return candidate
        return fenced.strip()
    if (
        candidate.startswith("`")
        and candidate.endswith("`")
        and candidate.count("`") == 2
    ):
        return candidate[1:-1].strip()
    return candidate


def parse_action_response(response_text: str) -> Tuple[bool, List[str]]:
    """Parse only whitespace-separated S/R/B/L commands."""
    candidate = normalize_action_response(response_text)
    if not STRICT_ACTIONS.fullmatch(candidate):
        return False, []
    return True, candidate.upper().split()


def rotate_direction(facing: str, relative_action_name: str) -> str:
    """Convert relative S/R/B/L to absolute N/E/S/W."""
    if facing not in DIR_TO_INT:
        raise ValueError(f"Unknown facing: {facing}")
    if relative_action_name not in REL_TO_DELTA:
        raise ValueError(f"Unknown relative action: {relative_action_name}")
    return INT_TO_DIR[(DIR_TO_INT[facing] + REL_TO_DELTA[relative_action_name]) % 4]


def relative_action(facing: str, absolute_direction: str) -> str:
    """Convert absolute N/E/S/W to relative S/R/B/L."""
    delta = (DIR_TO_INT[absolute_direction] - DIR_TO_INT[facing]) % 4
    return DELTA_TO_REL[delta]


def is_straight_pair(first: str, second: str) -> bool:
    return OPPOSITE[first] == second


# ---------------------------------------------------------------------------
# Serializable records
# ---------------------------------------------------------------------------

@dataclass
class MazeProblem:
    problem_id: str
    width: int
    height: int
    wall_density: float
    image_size: int
    seed: int

    start_cell: Cell
    goal_cell: Cell
    start_side: str
    goal_side: str
    initial_facing: str

    # Cell-level map and compressed decision graph.
    openings: Dict[str, List[str]]
    events: Dict[str, Dict]
    transitions: Dict[str, Dict[str, Dict]]

    answer_actions: List[str]
    answer_event_path: List[str]
    optimal_action_count: int

    ascii_rows: List[str]
    open_2x2_squares: List[List[int]]

    def to_jsonable(self) -> Dict:
        return asdict(self)


@dataclass
class ScoreResult:
    problem_id: str
    success: bool
    death: bool
    death_reason: Optional[str]
    first_invalid_action_index: Optional[int]

    optimal_action_count: int
    actual_action_count: int
    remaining_action_count: int

    completion_ratio: float
    efficiency_ratio: float
    score: float

    final_event: str
    final_cell: CellOrOutside
    final_facing: str

    actions_parsed: List[str]
    actions_executed: List[str]
    trajectory_events: List[str]
    trajectory_cells: List[CellOrOutside]

    def to_jsonable(self) -> Dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Maze generation
# ---------------------------------------------------------------------------

class MazeGenerator:
    """
    Generate a rectangular cell maze.

    wall_density is a style control:
      0.0 -> more extra openings, loops and junctions
      1.0 -> DFS-like perfect maze with long winding corridors

    Invariant: no 2x2 group of cells may have all four internal separating
    walls removed. This prevents ambiguous passage regions wider than one cell.
    """

    def __init__(
        self,
        width: int,
        height: int,
        wall_density: float = 0.70,
        image_size: int = 2048,
        seed: Optional[int] = None,
    ) -> None:
        if width < 2 or height < 2:
            raise ValueError("width and height must each be at least 2")
        if not 0.0 <= wall_density <= 1.0:
            raise ValueError("wall_density must be between 0 and 1")
        if image_size < 128:
            raise ValueError("image_size must be at least 128")

        self.width = int(width)
        self.height = int(height)
        self.wall_density = float(wall_density)
        self.image_size = int(image_size)
        self.seed = secrets.randbits(64) if seed is None else int(seed)
        self.rng = random.Random(self.seed)

        # True means the wall is present.
        self.walls: Dict[Cell, Dict[str, bool]] = {
            (x, y): {direction: True for direction in DIRS}
            for y in range(self.height)
            for x in range(self.width)
        }

    def _inside(self, x: int, y: int) -> bool:
        return 0 <= x < self.width and 0 <= y < self.height

    def _neighbors(self, cell: Cell) -> Iterable[Tuple[str, Cell]]:
        x, y = cell
        for direction, (dx, dy) in DIRS.items():
            neighbor = (x + dx, y + dy)
            if self._inside(*neighbor):
                yield direction, neighbor

    def _remove_wall(self, first: Cell, second: Cell, direction: str) -> None:
        self.walls[first][direction] = False
        self.walls[second][OPPOSITE[direction]] = False

    def _restore_wall(self, first: Cell, second: Cell, direction: str) -> None:
        self.walls[first][direction] = True
        self.walls[second][OPPOSITE[direction]] = True

    def _generate_spanning_tree(self) -> None:
        """Growing-tree maze; higher density biases toward long DFS corridors."""
        start = (self.rng.randrange(self.width), self.rng.randrange(self.height))
        visited = {start}
        active = [start]
        newest_bias = 0.15 + 0.85 * self.wall_density

        while active:
            index = len(active) - 1 if self.rng.random() < newest_bias else self.rng.randrange(len(active))
            current = active[index]
            unvisited = [
                (direction, neighbor)
                for direction, neighbor in self._neighbors(current)
                if neighbor not in visited
            ]
            if not unvisited:
                active.pop(index)
                continue

            direction, neighbor = self.rng.choice(unvisited)
            self._remove_wall(current, neighbor, direction)
            visited.add(neighbor)
            active.append(neighbor)

    def find_open_2x2_squares(self) -> List[Cell]:
        """
        Return top-left cells of fully open 2x2 regions.

        For top-left (x,y), the forbidden condition is that all four internal
        separating walls are absent:
          (x,y)-E, (x,y)-S, (x+1,y)-S, (x,y+1)-E.
        """
        bad: List[Cell] = []
        for y in range(self.height - 1):
            for x in range(self.width - 1):
                if (
                    not self.walls[(x, y)]["E"]
                    and not self.walls[(x, y)]["S"]
                    and not self.walls[(x + 1, y)]["S"]
                    and not self.walls[(x, y + 1)]["E"]
                ):
                    bad.append((x, y))
        return bad

    def _try_remove_wall_without_open_square(
        self,
        first: Cell,
        second: Cell,
        direction: str,
    ) -> bool:
        """Remove one wall only if it does not complete a fully open 2x2 block."""
        self._remove_wall(first, second, direction)
        if self.find_open_2x2_squares():
            self._restore_wall(first, second, direction)
            return False
        return True

    def _add_extra_openings(self) -> None:
        """Add loops while preserving the no-open-2x2 invariant."""
        candidates: List[Tuple[Cell, Cell, str]] = []
        for y in range(self.height):
            for x in range(self.width):
                cell = (x, y)
                for direction in ("E", "S"):  # each internal wall once
                    dx, dy = DIRS[direction]
                    neighbor = (x + dx, y + dy)
                    if self._inside(*neighbor) and self.walls[cell][direction]:
                        candidates.append((cell, neighbor, direction))

        self.rng.shuffle(candidates)
        openness = 1.0 - self.wall_density
        target_removals = round(openness * 0.35 * len(candidates))

        removed = 0
        for cell, neighbor, direction in candidates:
            if removed >= target_removals:
                break
            if self._try_remove_wall_without_open_square(cell, neighbor, direction):
                removed += 1

    def _border_cell(self, side: str) -> Cell:
        if side == "N":
            return self.rng.randrange(self.width), 0
        if side == "S":
            return self.rng.randrange(self.width), self.height - 1
        if side == "W":
            return 0, self.rng.randrange(self.height)
        if side == "E":
            return self.width - 1, self.rng.randrange(self.height)
        raise ValueError(f"Unknown side: {side}")

    def _choose_start_goal(
        self,
        forced_start_side: Optional[str] = None,
        forced_goal_side: Optional[str] = None,
    ) -> Tuple[Cell, Cell, str, str, str]:
        start_side = forced_start_side or self.rng.choice(VALID_SIDES)
        if start_side not in VALID_SIDES:
            raise ValueError("start_side must be N, E, S or W")

        if forced_goal_side is not None:
            goal_side = forced_goal_side
        else:
            # Same-side placement is allowed. Opposite remains slightly more likely.
            weighted_goal_sides = [
                start_side,
                OPPOSITE[start_side],
                OPPOSITE[start_side],
                OPPOSITE[start_side],
                *[side for side in VALID_SIDES if side not in {start_side, OPPOSITE[start_side]}],
            ]
            goal_side = self.rng.choice(weighted_goal_sides)

        if goal_side not in VALID_SIDES:
            raise ValueError("goal_side must be N, E, S or W")

        start_cell = self._border_cell(start_side)
        goal_cell = self._border_cell(goal_side)
        while goal_cell == start_cell:
            goal_cell = self._border_cell(goal_side)

        # The blue arrow points from outside into the maze.
        initial_facing = OPPOSITE[start_side]
        return start_cell, goal_cell, start_side, goal_side, initial_facing

    def _cell_openings(self) -> Dict[str, List[str]]:
        return {
            f"{x},{y}": [direction for direction in "NESW" if not self.walls[(x, y)][direction]]
            for y in range(self.height)
            for x in range(self.width)
        }

    @staticmethod
    def _is_event(
        cell: Cell,
        goal_cell: Cell,
        augmented_openings: List[str],
    ) -> bool:
        # The cell immediately before the red exit is always an event: the
        # model must explicitly issue the final command that leaves the maze.
        if cell == goal_cell:
            return True
        # Dead ends, T-junctions and four-way junctions.
        if len(augmented_openings) != 2:
            return True
        # A corner is an event; a straight 2-way corridor is automatic.
        return not is_straight_pair(augmented_openings[0], augmented_openings[1])

    def _build_event_graph(
        self,
        start_cell: Cell,
        goal_cell: Cell,
        start_side: str,
        goal_side: str,
        initial_facing: str,
    ) -> Tuple[Dict[str, List[str]], Dict[str, Dict], Dict[str, Dict[str, Dict]], str, str]:
        openings = self._cell_openings()

        def augmented_dirs(cell: Cell) -> List[str]:
            dirs = list(openings[f"{cell[0]},{cell[1]}"])
            if cell == start_cell and start_side not in dirs:
                dirs.append(start_side)
            if cell == goal_cell and goal_side not in dirs:
                dirs.append(goal_side)
            return dirs

        event_cells: List[Cell] = []
        for y in range(self.height):
            for x in range(self.width):
                cell = (x, y)
                if self._is_event(cell, goal_cell, augmented_dirs(cell)):
                    event_cells.append(cell)

        event_id_by_cell = {cell: f"E{index}" for index, cell in enumerate(event_cells)}

        events: Dict[str, Dict] = {
            START_OUT: {
                "cell": START_OUT,
                "external": True,
                "is_start": True,
                "is_goal": False,
                "open_dirs": [initial_facing],
            },
            GOAL_OUT: {
                "cell": GOAL_OUT,
                "external": True,
                "is_start": False,
                "is_goal": True,
                "open_dirs": [],
            },
        }

        for cell in event_cells:
            event_id = event_id_by_cell[cell]
            events[event_id] = {
                "cell": [cell[0], cell[1]],
                "external": False,
                "is_start": False,
                "is_goal": False,
                "is_start_cell": cell == start_cell,
                "is_goal_cell": cell == goal_cell,
                "open_dirs": augmented_dirs(cell),
            }

        transitions: Dict[str, Dict[str, Dict]] = {event_id: {} for event_id in events}

        def step(cell_or_outside: CellOrOutside, direction: str) -> CellOrOutside:
            if cell_or_outside == START_OUT:
                return start_cell
            if cell_or_outside == GOAL_OUT:
                raise MazeError("GOAL_OUT is terminal")
            cell = cell_or_outside
            if cell == start_cell and direction == start_side:
                return START_OUT
            if cell == goal_cell and direction == goal_side:
                return GOAL_OUT
            dx, dy = DIRS[direction]
            next_cell = (cell[0] + dx, cell[1] + dy)
            if not self._inside(*next_cell):
                raise MazeError(f"Unexpected move outside maze from {cell} toward {direction}")
            return next_cell

        def dirs_at(cell_or_outside: CellOrOutside) -> List[str]:
            if cell_or_outside == START_OUT:
                return [initial_facing]
            if cell_or_outside == GOAL_OUT:
                return []
            return augmented_dirs(cell_or_outside)

        def event_id_at(cell_or_outside: CellOrOutside) -> Optional[str]:
            if cell_or_outside == START_OUT:
                return START_OUT
            if cell_or_outside == GOAL_OUT:
                return GOAL_OUT
            return event_id_by_cell.get(cell_or_outside)

        def trace_to_next_event(
            source: CellOrOutside,
            initial_direction: str,
        ) -> Tuple[str, int, CellOrOutside]:
            current: CellOrOutside = source
            heading = initial_direction
            traversed_cells = 0

            while True:
                next_position = step(current, heading)
                traversed_cells += 1
                next_event = event_id_at(next_position)
                if next_event is not None:
                    return next_event, traversed_cells, next_position

                continuations = [
                    direction
                    for direction in dirs_at(next_position)
                    if direction != OPPOSITE[heading]
                ]
                if len(continuations) != 1:
                    raise MazeError(
                        f"A non-event corridor position {next_position} had "
                        f"{len(continuations)} continuations"
                    )
                current = next_position
                heading = continuations[0]

        # START_OUT has one action. Because facing==initial_facing, it is S.
        destination, steps, destination_position = trace_to_next_event(START_OUT, initial_facing)
        transitions[START_OUT][initial_facing] = {
            "to": destination,
            "steps": steps,
            "to_cell": list(destination_position) if isinstance(destination_position, tuple) else destination_position,
            "external": True,
        }

        # Every internal event has one edge for each available absolute direction.
        for cell in event_cells:
            source_event = event_id_by_cell[cell]
            for initial_direction in augmented_dirs(cell):
                destination, steps, destination_position = trace_to_next_event(cell, initial_direction)
                transitions[source_event][initial_direction] = {
                    "to": destination,
                    "steps": steps,
                    "to_cell": list(destination_position) if isinstance(destination_position, tuple) else destination_position,
                    "external": destination in {START_OUT, GOAL_OUT},
                }

        return openings, events, transitions, START_OUT, GOAL_OUT

    @staticmethod
    def _shortest_action_path(
        start_event: str,
        goal_event: str,
        initial_facing: str,
        transitions: Dict[str, Dict[str, Dict]],
    ) -> Tuple[List[str], List[str], int]:
        start_state = (start_event, initial_facing)
        queue = deque([start_state])
        distance = {start_state: 0}
        parent = {start_state: None}
        used_action = {start_state: None}

        goal_state: Optional[Tuple[str, str]] = None
        while queue:
            event_id, facing = queue.popleft()
            state = (event_id, facing)

            if event_id == goal_event:
                goal_state = state
                break

            for absolute_direction, edge in transitions[event_id].items():
                next_state = (edge["to"], absolute_direction)
                if next_state in distance:
                    continue
                distance[next_state] = distance[state] + 1
                parent[next_state] = state
                used_action[next_state] = relative_action(facing, absolute_direction)
                queue.append(next_state)

        if goal_state is None:
            raise MazeError("Goal is unreachable in the event-state graph")

        actions: List[str] = []
        event_path: List[str] = []
        current: Optional[Tuple[str, str]] = goal_state
        while current is not None:
            event_path.append(current[0])
            action = used_action[current]
            if action is not None:
                actions.append(action)
            current = parent[current]

        actions.reverse()
        event_path.reverse()
        return actions, event_path, distance[goal_state]

    def _ascii_map(
        self,
        start_cell: Cell,
        goal_cell: Cell,
        start_side: str,
        goal_side: str,
    ) -> List[str]:
        # One-character blank margin around the standard wall/path map.
        inner_width = 2 * self.width + 1
        inner_height = 2 * self.height + 1
        rows = [[" "] * (inner_width + 2) for _ in range(inner_height + 2)]

        for iy in range(inner_height):
            for ix in range(inner_width):
                rows[iy + 1][ix + 1] = "#"

        for y in range(self.height):
            for x in range(self.width):
                center_x, center_y = 2 * x + 2, 2 * y + 2
                rows[center_y][center_x] = "."
                for direction, (dx, dy) in DIRS.items():
                    if not self.walls[(x, y)][direction]:
                        rows[center_y + dy][center_x + dx] = "."

        def external_marker(cell: Cell, side: str, marker: str) -> None:
            x, y = cell
            center_x, center_y = 2 * x + 2, 2 * y + 2
            dx, dy = DIRS[side]
            rows[center_y + dy][center_x + dx] = "."  # boundary gap
            rows[center_y + 2 * dy][center_x + 2 * dx] = marker

        external_marker(start_cell, start_side, "A")
        external_marker(goal_cell, goal_side, "G")
        return ["".join(row) for row in rows]

    def generate(
        self,
        problem_id: Optional[str] = None,
        start_side: Optional[str] = None,
        goal_side: Optional[str] = None,
    ) -> MazeProblem:
        self._generate_spanning_tree()
        self._add_extra_openings()

        bad_squares = self.find_open_2x2_squares()
        if bad_squares:
            raise MazeError(f"Generated maze contains open 2x2 regions: {bad_squares}")

        start_cell, goal_cell, selected_start_side, selected_goal_side, initial_facing = self._choose_start_goal(
            forced_start_side=start_side,
            forced_goal_side=goal_side,
        )

        openings, events, transitions, start_event, goal_event = self._build_event_graph(
            start_cell,
            goal_cell,
            selected_start_side,
            selected_goal_side,
            initial_facing,
        )

        answer_actions, answer_event_path, optimal_action_count = self._shortest_action_path(
            start_event,
            goal_event,
            initial_facing,
            transitions,
        )

        if not answer_actions or answer_actions[0] != "S":
            raise MazeError("Invariant failed: shortest answer must begin with S")
        if answer_event_path[0] != START_OUT or answer_event_path[-1] != GOAL_OUT:
            raise MazeError("Invariant failed: answer path must run START_OUT -> GOAL_OUT")

        if problem_id is None:
            problem_id = f"maze_{self.width}x{self.height}_{self.seed}"

        return MazeProblem(
            problem_id=problem_id,
            width=self.width,
            height=self.height,
            wall_density=self.wall_density,
            image_size=self.image_size,
            seed=self.seed,
            start_cell=start_cell,
            goal_cell=goal_cell,
            start_side=selected_start_side,
            goal_side=selected_goal_side,
            initial_facing=initial_facing,
            openings=openings,
            events=events,
            transitions=transitions,
            answer_actions=answer_actions,
            answer_event_path=answer_event_path,
            optimal_action_count=optimal_action_count,
            ascii_rows=self._ascii_map(
                start_cell,
                goal_cell,
                selected_start_side,
                selected_goal_side,
            ),
            open_2x2_squares=[[x, y] for x, y in bad_squares],
        )


# ---------------------------------------------------------------------------
# Image rendering
# ---------------------------------------------------------------------------

class MazeRenderer:
    def __init__(self, problem: MazeProblem) -> None:
        if Image is None or ImageDraw is None:
            raise RuntimeError("Pillow is required. Install it with: pip install pillow")
        self.problem = problem

    @staticmethod
    def _arrow_polygon(
        center_x: float,
        center_y: float,
        direction: str,
        size: float,
    ) -> List[Tuple[float, float]]:
        # Base polygon points East.
        half = size / 2.0
        points = [
            (half, 0),
            (-half * 0.10, -half * 0.72),
            (-half * 0.10, -half * 0.30),
            (-half, -half * 0.30),
            (-half, half * 0.30),
            (-half * 0.10, half * 0.30),
            (-half * 0.10, half * 0.72),
        ]
        angle = {"E": 0.0, "S": math.pi / 2, "W": math.pi, "N": 3 * math.pi / 2}[direction]
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        return [
            (
                center_x + x * cos_a - y * sin_a,
                center_y + x * sin_a + y * cos_a,
            )
            for x, y in points
        ]

    def render(self, output_path: str | Path) -> None:
        size = self.problem.image_size
        image = Image.new("RGB", (size, size), (250, 250, 250))
        draw = ImageDraw.Draw(image)

        edge_padding = max(16, round(size * 0.01))
        # Reserve 1.125 cells for the arrow offset and half-length.
        arrow_clearance = 1.20
        available = size - 2 * edge_padding
        cell_size = min(
            available / (self.problem.width + 2 * arrow_clearance),
            available / (self.problem.height + 2 * arrow_clearance),
        )
        maze_width = cell_size * self.problem.width
        maze_height = cell_size * self.problem.height
        origin_x = (size - maze_width) / 2
        origin_y = (size - maze_height) / 2

        # Thin enough to preserve corridor readability at 25x20.
        line_width = max(3, round(cell_size * 0.065))

        def point(grid_x: float, grid_y: float) -> Tuple[float, float]:
            return origin_x + grid_x * cell_size, origin_y + grid_y * cell_size

        draw.rectangle(
            [origin_x, origin_y, origin_x + maze_width, origin_y + maze_height],
            fill=(255, 255, 255),
        )

        start = tuple(self.problem.start_cell)
        goal = tuple(self.problem.goal_cell)

        # Draw each wall once, suppressing only the two exterior openings.
        for y in range(self.problem.height):
            for x in range(self.problem.width):
                open_dirs = set(self.problem.openings[f"{x},{y}"])
                cell = (x, y)

                suppress_n = (cell == start and self.problem.start_side == "N") or (
                    cell == goal and self.problem.goal_side == "N"
                )
                suppress_w = (cell == start and self.problem.start_side == "W") or (
                    cell == goal and self.problem.goal_side == "W"
                )
                suppress_e = (cell == start and self.problem.start_side == "E") or (
                    cell == goal and self.problem.goal_side == "E"
                )
                suppress_s = (cell == start and self.problem.start_side == "S") or (
                    cell == goal and self.problem.goal_side == "S"
                )

                if y == 0 and not suppress_n:
                    draw.line([point(x, y), point(x + 1, y)], fill=(20, 20, 20), width=line_width)
                if x == 0 and not suppress_w:
                    draw.line([point(x, y), point(x, y + 1)], fill=(20, 20, 20), width=line_width)
                if "E" not in open_dirs and not (x == self.problem.width - 1 and suppress_e):
                    draw.line([point(x + 1, y), point(x + 1, y + 1)], fill=(20, 20, 20), width=line_width)
                if "S" not in open_dirs and not (y == self.problem.height - 1 and suppress_s):
                    draw.line([point(x, y + 1), point(x + 1, y + 1)], fill=(20, 20, 20), width=line_width)

        def outside_arrow_center(cell: Cell, side: str) -> Tuple[float, float]:
            x, y = cell
            center_x, center_y = point(x + 0.5, y + 0.5)
            offset = cell_size * 1.15
            dx, dy = DIRS[side]
            return center_x + dx * offset, center_y + dy * offset

        # Blue points inward; red points outward.
        start_center = outside_arrow_center(start, self.problem.start_side)
        goal_center = outside_arrow_center(goal, self.problem.goal_side)
        arrow_size = max(24.0, cell_size * 0.95)

        draw.polygon(
            self._arrow_polygon(
                start_center[0],
                start_center[1],
                self.problem.initial_facing,
                arrow_size,
            ),
            fill=(55, 125, 235),
            outline=(25, 75, 170),
        )
        draw.polygon(
            self._arrow_polygon(
                goal_center[0],
                goal_center[1],
                self.problem.goal_side,
                arrow_size,
            ),
            fill=(245, 80, 80),
            outline=(170, 40, 40),
        )

        image.save(output_path)


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

class MazeScorer:
    def __init__(self, problem: MazeProblem) -> None:
        self.problem = problem
        if START_OUT not in problem.events or GOAL_OUT not in problem.events:
            raise MazeError("Problem JSON is from an obsolete format: START_OUT/GOAL_OUT missing")
        self.start_event = START_OUT
        self.goal_event = GOAL_OUT
        self.optimal_distance = int(problem.optimal_action_count)
        self._remaining_cache: Dict[Tuple[str, str], int] = {}

    @staticmethod
    def parse_actions(text: str) -> List[str]:
        return parse_action_response(text)[1]

    def _event_cell(self, event_id: str) -> CellOrOutside:
        cell = self.problem.events[event_id]["cell"]
        return tuple(cell) if isinstance(cell, list) else str(cell)

    def remaining_distance(self, event_id: str, facing: str) -> int:
        key = (event_id, facing)
        if key in self._remaining_cache:
            return self._remaining_cache[key]

        queue = deque([key])
        distance = {key: 0}
        while queue:
            current_event, current_facing = queue.popleft()
            state = (current_event, current_facing)
            if current_event == self.goal_event:
                self._remaining_cache[key] = distance[state]
                return distance[state]

            for absolute_direction, edge in self.problem.transitions[current_event].items():
                next_state = (edge["to"], absolute_direction)
                if next_state not in distance:
                    distance[next_state] = distance[state] + 1
                    queue.append(next_state)

        raise MazeError("Goal became unreachable from a valid maze state")

    def score_actions(self, actions: Sequence[str]) -> ScoreResult:
        current_event = self.start_event
        facing = self.problem.initial_facing
        successful_moves = 0
        executed: List[str] = []
        trajectory_events: List[str] = [current_event]
        trajectory_cells: List[CellOrOutside] = [self._event_cell(current_event)]

        success = False
        death = False
        death_reason: Optional[str] = None
        invalid_index: Optional[int] = None
        normalized_actions = [str(action).upper() for action in actions]

        for index, action in enumerate(normalized_actions):
            if action not in VALID_ACTIONS:
                death = True
                invalid_index = index
                death_reason = f"invalid action token: {action}"
                break

            absolute_direction = rotate_direction(facing, action)
            available = self.problem.transitions[current_event]
            if absolute_direction not in available:
                death = True
                invalid_index = index
                death_reason = (
                    f"collision at {current_event} ({self._event_cell(current_event)}): "
                    f"{action} relative to facing {facing} means {absolute_direction}"
                )
                break

            edge = available[absolute_direction]
            current_event = edge["to"]
            facing = absolute_direction
            successful_moves += 1
            executed.append(action)
            trajectory_events.append(current_event)
            trajectory_cells.append(self._event_cell(current_event))

            if current_event == self.goal_event:
                success = True
                break

        remaining = 0 if success else self.remaining_distance(current_event, facing)
        D = self.optimal_distance
        m = successful_moves
        r = remaining

        completion = m / (m + r) if (m + r) > 0 else 0.0
        efficiency = D / (m + r) if (m + r) > 0 else 1.0
        score = 100.0 * completion * efficiency

        return ScoreResult(
            problem_id=self.problem.problem_id,
            success=success,
            death=death,
            death_reason=death_reason,
            first_invalid_action_index=invalid_index,
            optimal_action_count=D,
            actual_action_count=m,
            remaining_action_count=r,
            completion_ratio=completion,
            efficiency_ratio=efficiency,
            score=score,
            final_event=current_event,
            final_cell=self._event_cell(current_event),
            final_facing=facing,
            actions_parsed=normalized_actions,
            actions_executed=executed,
            trajectory_events=trajectory_events,
            trajectory_cells=trajectory_cells,
        )

    def score_log(self, text: str) -> ScoreResult:
        return self.score_actions(self.parse_actions(text))

    def grade_log(self, text: str) -> Tuple[bool, Dict]:
        """Grade a raw response and apply strict output-format scoring."""
        format_valid, actions = parse_action_response(text)
        grading = self.score_actions(actions).to_jsonable()
        grading["format_valid"] = format_valid
        if not format_valid:
            grading["unadjusted_score"] = grading["score"]
            grading["score"] = 0.0
            grading["grading_reason"] = "empty or invalid command format"
        return format_valid, grading


# ---------------------------------------------------------------------------
# Validation, persistence and CLI
# ---------------------------------------------------------------------------


def find_open_2x2_from_openings(problem: MazeProblem) -> List[List[int]]:
    """Recompute fully open 2x2 regions from serialized cell openings."""
    bad: List[List[int]] = []
    for y in range(problem.height - 1):
        for x in range(problem.width - 1):
            top_left = set(problem.openings[f"{x},{y}"])
            top_right = set(problem.openings[f"{x + 1},{y}"])
            bottom_left = set(problem.openings[f"{x},{y + 1}"])
            if (
                "E" in top_left
                and "S" in top_left
                and "S" in top_right
                and "E" in bottom_left
            ):
                bad.append([x, y])
    return bad


def _problem_cell(value: object) -> Optional[Cell]:
    """Convert a serialized cell coordinate to a validated tuple."""
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or any(type(coordinate) is not int for coordinate in value)
    ):
        return None
    return value[0], value[1]


def _inside_problem(problem: MazeProblem, cell: Cell) -> bool:
    """Return whether a cell lies inside the serialized maze bounds."""
    return 0 <= cell[0] < problem.width and 0 <= cell[1] < problem.height


def _augmented_openings(problem: MazeProblem, cell: Cell) -> List[str]:
    """Return cell openings including the two exterior benchmark openings."""
    directions = list(problem.openings.get(f"{cell[0]},{cell[1]}", []))
    if cell == tuple(problem.start_cell) and problem.start_side not in directions:
        directions.append(problem.start_side)
    if cell == tuple(problem.goal_cell) and problem.goal_side not in directions:
        directions.append(problem.goal_side)
    return directions


def _validate_serialized_graph(problem: MazeProblem, errors: List[str]) -> None:
    """Validate coordinates, openings, events, and compressed transitions."""
    if type(problem.width) is not int or type(problem.height) is not int:
        errors.append("width and height must be integers")
        return
    if problem.width < 2 or problem.height < 2:
        errors.append("width and height must each be at least 2")
        return

    start = _problem_cell(problem.start_cell)
    goal = _problem_cell(problem.goal_cell)
    for label, cell, side in (
        ("start", start, problem.start_side),
        ("goal", goal, problem.goal_side),
    ):
        if cell is None or not _inside_problem(problem, cell):
            errors.append(f"{label}_cell is outside maze bounds")
            continue
        if side not in VALID_SIDES:
            errors.append(f"{label}_side is invalid: {side}")
            continue
        x, y = cell
        on_side = {
            "N": y == 0,
            "E": x == problem.width - 1,
            "S": y == problem.height - 1,
            "W": x == 0,
        }[side]
        if not on_side:
            errors.append(f"{label}_cell is not on its declared {side} side")
    if start is None or goal is None:
        return
    if start == goal:
        errors.append("start_cell and goal_cell must differ")
    if (
        problem.start_side in VALID_SIDES
        and problem.initial_facing != OPPOSITE[problem.start_side]
    ):
        errors.append("initial_facing does not point inward from start_side")

    expected_cell_keys = {
        f"{x},{y}"
        for y in range(problem.height)
        for x in range(problem.width)
    }
    actual_cell_keys = set(problem.openings)
    if actual_cell_keys != expected_cell_keys:
        missing = sorted(expected_cell_keys - actual_cell_keys)
        extra = sorted(actual_cell_keys - expected_cell_keys)
        errors.append(f"opening cell keys mismatch: missing={missing}, extra={extra}")

    openings_valid = actual_cell_keys == expected_cell_keys
    for key in sorted(actual_cell_keys & expected_cell_keys):
        raw_directions = problem.openings[key]
        if not isinstance(raw_directions, list):
            errors.append(f"openings[{key}] must be a list")
            openings_valid = False
            continue
        if len(raw_directions) != len(set(raw_directions)):
            errors.append(f"openings[{key}] contains duplicate directions")
            openings_valid = False
        invalid = [direction for direction in raw_directions if direction not in DIRS]
        if invalid:
            errors.append(f"openings[{key}] contains invalid directions: {invalid}")
            openings_valid = False
            continue
        x, y = (int(part) for part in key.split(","))
        for direction in raw_directions:
            dx, dy = DIRS[direction]
            neighbor = (x + dx, y + dy)
            if not _inside_problem(problem, neighbor):
                errors.append(
                    f"openings[{key}] points outside the maze toward {direction}"
                )
                openings_valid = False
                continue
            neighbor_key = f"{neighbor[0]},{neighbor[1]}"
            neighbor_openings = problem.openings.get(neighbor_key)
            if (
                isinstance(neighbor_openings, list)
                and OPPOSITE[direction] not in neighbor_openings
            ):
                errors.append(
                    f"opening symmetry mismatch: {key} {direction} lacks "
                    f"{neighbor_key} {OPPOSITE[direction]}"
                )
                openings_valid = False

    if not openings_valid:
        return

    event_id_by_cell: Dict[Cell, str] = {}
    for event_id, event in problem.events.items():
        if not isinstance(event, dict):
            errors.append(f"event {event_id} must be an object")
            continue
        if event_id in {START_OUT, GOAL_OUT}:
            if event.get("cell") != event_id:
                errors.append(f"{event_id} has an invalid external cell")
            continue
        cell = _problem_cell(event.get("cell"))
        if cell is None or not _inside_problem(problem, cell):
            errors.append(f"event {event_id} has an invalid cell coordinate")
            continue
        if cell in event_id_by_cell:
            errors.append(
                f"events {event_id_by_cell[cell]} and {event_id} share cell {cell}"
            )
            continue
        event_id_by_cell[cell] = event_id

    expected_event_cells = {
        (x, y)
        for y in range(problem.height)
        for x in range(problem.width)
        if MazeGenerator._is_event(
            (x, y),
            goal,
            _augmented_openings(problem, (x, y)),
        )
    }
    if set(event_id_by_cell) != expected_event_cells:
        missing = sorted(expected_event_cells - set(event_id_by_cell))
        extra = sorted(set(event_id_by_cell) - expected_event_cells)
        errors.append(f"event cell mismatch: missing={missing}, extra={extra}")

    for cell, event_id in event_id_by_cell.items():
        open_dirs = problem.events[event_id].get("open_dirs")
        expected_dirs = _augmented_openings(problem, cell)
        if (
            not isinstance(open_dirs, list)
            or len(open_dirs) != len(set(open_dirs))
            or set(open_dirs) != set(expected_dirs)
        ):
            errors.append(f"event {event_id} open_dirs do not match cell openings")

    if set(problem.transitions) != set(problem.events):
        missing = sorted(set(problem.events) - set(problem.transitions))
        extra = sorted(set(problem.transitions) - set(problem.events))
        errors.append(f"transition source mismatch: missing={missing}, extra={extra}")
        return
    if set(event_id_by_cell) != expected_event_cells:
        return

    def step(position: CellOrOutside, direction: str) -> CellOrOutside:
        if position == START_OUT:
            if direction != problem.initial_facing:
                raise MazeError("START_OUT transition does not use initial_facing")
            return start
        if not isinstance(position, tuple):
            raise MazeError(f"cannot step from terminal event {position}")
        if position == start and direction == problem.start_side:
            return START_OUT
        if position == goal and direction == problem.goal_side:
            return GOAL_OUT
        if direction not in problem.openings[f"{position[0]},{position[1]}"]:
            raise MazeError(f"transition crosses a wall at {position} toward {direction}")
        dx, dy = DIRS[direction]
        return position[0] + dx, position[1] + dy

    def trace(source: CellOrOutside, direction: str) -> Tuple[str, int, CellOrOutside]:
        position = source
        heading = direction
        for steps in range(1, problem.width * problem.height + 3):
            position = step(position, heading)
            if position == START_OUT:
                return START_OUT, steps, position
            if position == GOAL_OUT:
                return GOAL_OUT, steps, position
            event_id = event_id_by_cell.get(position)
            if event_id is not None:
                return event_id, steps, position
            continuations = [
                candidate
                for candidate in _augmented_openings(problem, position)
                if candidate != OPPOSITE[heading]
            ]
            if len(continuations) != 1:
                raise MazeError(
                    f"non-event corridor {position} has "
                    f"{len(continuations)} continuations"
                )
            heading = continuations[0]
        raise MazeError(f"transition from {source} did not reach an event")

    for source_event, raw_edges in problem.transitions.items():
        if not isinstance(raw_edges, dict):
            errors.append(f"transitions[{source_event}] must be an object")
            continue
        if source_event == GOAL_OUT:
            expected_directions: set[str] = set()
            source_position: CellOrOutside = GOAL_OUT
        elif source_event == START_OUT:
            expected_directions = {problem.initial_facing}
            source_position = START_OUT
        else:
            source_position = _problem_cell(problem.events[source_event].get("cell"))
            if source_position is None:
                continue
            expected_directions = set(_augmented_openings(problem, source_position))
        if set(raw_edges) != expected_directions:
            errors.append(
                f"transition directions for {source_event} do not match openings"
            )
            continue
        for direction, edge in raw_edges.items():
            if not isinstance(edge, dict):
                errors.append(f"transition {source_event}/{direction} must be an object")
                continue
            try:
                destination, steps, destination_cell = trace(
                    source_position,
                    direction,
                )
            except MazeError as error:
                errors.append(f"transition {source_event}/{direction}: {error}")
                continue
            serialized_cell: CellOrOutside = (
                list(destination_cell)
                if isinstance(destination_cell, tuple)
                else destination_cell
            )
            if (
                edge.get("to") != destination
                or edge.get("steps") != steps
                or edge.get("to_cell") != serialized_cell
                or edge.get("external")
                is not (
                    source_event == START_OUT
                    or destination in {START_OUT, GOAL_OUT}
                )
            ):
                errors.append(
                    f"transition {source_event}/{direction} does not match "
                    "the serialized openings"
                )


def validate_problem(problem: MazeProblem) -> Dict:
    errors: List[str] = []

    events_valid = isinstance(problem.events, dict)
    transitions_valid = isinstance(problem.transitions, dict)
    openings_valid = isinstance(problem.openings, dict)
    answer_actions_valid = isinstance(problem.answer_actions, list)
    answer_path_valid = isinstance(problem.answer_event_path, list)
    open_2x2_valid = isinstance(problem.open_2x2_squares, list)
    for field_name, valid, expected in (
        ("events", events_valid, "object"),
        ("transitions", transitions_valid, "object"),
        ("openings", openings_valid, "object"),
        ("answer_actions", answer_actions_valid, "array"),
        ("answer_event_path", answer_path_valid, "array"),
        ("open_2x2_squares", open_2x2_valid, "array"),
    ):
        if not valid:
            errors.append(f"{field_name} must be an {expected}")

    if events_valid and START_OUT not in problem.events:
        errors.append("START_OUT missing")
    if events_valid and GOAL_OUT not in problem.events:
        errors.append("GOAL_OUT missing")
    if answer_actions_valid and (
        not problem.answer_actions or problem.answer_actions[0] != "S"
    ):
        errors.append("shortest answer does not start with S")
    if answer_path_valid and (
        not problem.answer_event_path or problem.answer_event_path[0] != START_OUT
    ):
        errors.append("answer path does not start at START_OUT")
    if answer_path_valid and (
        not problem.answer_event_path or problem.answer_event_path[-1] != GOAL_OUT
    ):
        errors.append("answer path does not end at GOAL_OUT")
    if (
        answer_actions_valid
        and answer_path_valid
        and len(problem.answer_event_path) != len(problem.answer_actions) + 1
    ):
        errors.append("answer event path length does not match answer action count")
    if (
        answer_actions_valid
        and problem.optimal_action_count != len(problem.answer_actions)
    ):
        errors.append("optimal_action_count does not match answer action count")

    graph_containers_valid = events_valid and transitions_valid and openings_valid
    if graph_containers_valid:
        _validate_serialized_graph(problem, errors)

    recomputed_open_2x2 = []
    if openings_valid:
        try:
            recomputed_open_2x2 = find_open_2x2_from_openings(problem)
        except (KeyError, TypeError, ValueError):
            errors.append("open 2x2 regions could not be recomputed")
    if open_2x2_valid and problem.open_2x2_squares:
        errors.append(f"stored open 2x2 regions present: {problem.open_2x2_squares}")
    if recomputed_open_2x2:
        errors.append(f"recomputed open 2x2 regions present: {recomputed_open_2x2}")

    perfect: Optional[ScoreResult] = None
    missing_exit: Optional[ScoreResult] = None
    non_s_results = {}
    if graph_containers_valid and answer_actions_valid and answer_path_valid:
        try:
            scorer = MazeScorer(problem)
            perfect = scorer.score_actions(problem.answer_actions)
            if not perfect.success or abs(perfect.score - 100.0) > 1e-9:
                errors.append(f"shortest answer did not score 100: {perfect.score}")
            if perfect.trajectory_events != problem.answer_event_path:
                errors.append("answer event path does not match replayed answer actions")

            _, _, recomputed_optimal_count = MazeGenerator._shortest_action_path(
                START_OUT,
                GOAL_OUT,
                problem.initial_facing,
                problem.transitions,
            )
            if recomputed_optimal_count != problem.optimal_action_count:
                errors.append(
                    "optimal_action_count does not match recomputed shortest path"
                )

            for action in ("R", "B", "L"):
                result = scorer.score_actions([action])
                non_s_results[action] = result.to_jsonable()
                if not result.death or result.actual_action_count != 0:
                    errors.append(f"first action {action} was not rejected at START_OUT")

            missing_exit = scorer.score_actions(problem.answer_actions[:-1])
            if missing_exit.success:
                errors.append("goal was accepted without the final exit action")
        except (KeyError, MazeError, TypeError, ValueError) as error:
            errors.append(f"problem graph could not be scored: {error}")

    return {
        "valid": not errors,
        "errors": errors,
        "checks": {
            "has_START_OUT": events_valid and START_OUT in problem.events,
            "has_GOAL_OUT": events_valid and GOAL_OUT in problem.events,
            "answer_starts_with_S": bool(
                answer_actions_valid
                and problem.answer_actions
                and problem.answer_actions[0] == "S"
            ),
            "answer_path_starts_START_OUT": bool(
                answer_path_valid
                and problem.answer_event_path
                and problem.answer_event_path[0] == START_OUT
            ),
            "answer_path_ends_GOAL_OUT": bool(
                answer_path_valid
                and problem.answer_event_path
                and problem.answer_event_path[-1] == GOAL_OUT
            ),
            "stored_open_2x2_count": (
                len(problem.open_2x2_squares) if open_2x2_valid else None
            ),
            "recomputed_open_2x2_count": len(recomputed_open_2x2),
            "perfect_answer_score": perfect.score if perfect else None,
            "perfect_answer_success": perfect.success if perfect else False,
            "answer_path_matches_replay": bool(
                perfect
                and perfect.trajectory_events == problem.answer_event_path
            ),
            "optimal_count_matches_answer": (
                answer_actions_valid
                and problem.optimal_action_count == len(problem.answer_actions)
            ),
            "missing_final_exit_success": (
                missing_exit.success if missing_exit else None
            ),
            "missing_final_exit_remaining": (
                missing_exit.remaining_action_count if missing_exit else None
            ),
            "first_non_S_results": non_s_results,
        },
    }


def save_problem(problem: MazeProblem, output_directory: str | Path) -> Dict[str, str]:
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)

    json_path = output_directory / f"{problem.problem_id}.json"
    map_path = output_directory / f"{problem.problem_id}.txt"
    answer_path = output_directory / f"{problem.problem_id}.answer.txt"
    image_path = output_directory / f"{problem.problem_id}.png"
    validation_path = output_directory / f"{problem.problem_id}.validation.json"

    json_path.write_text(json.dumps(problem.to_jsonable(), ensure_ascii=False, indent=2), encoding="utf-8")

    with map_path.open("w", encoding="utf-8") as file:
        file.write(f"problem_id: {problem.problem_id}\n")
        file.write(f"size: {problem.width}x{problem.height}\n")
        file.write(f"wall_density: {problem.wall_density}\n")
        file.write(f"seed: {problem.seed}\n")
        file.write(f"start_cell: {tuple(problem.start_cell)} on {problem.start_side} side\n")
        file.write(f"goal_cell: {tuple(problem.goal_cell)} on {problem.goal_side} side\n")
        file.write(f"initial_facing: {problem.initial_facing}\n")
        file.write("legend: #=wall, .=corridor, A=start outside, G=goal outside\n\n")
        file.write("\n".join(problem.ascii_rows))
        file.write("\n")

    with answer_path.open("w", encoding="utf-8") as file:
        file.write(f"problem_id: {problem.problem_id}\n")
        file.write(f"optimal_action_count: {problem.optimal_action_count}\n")
        file.write("optimal_actions: " + " ".join(problem.answer_actions) + "\n")
        file.write("optimal_event_path: " + " -> ".join(problem.answer_event_path) + "\n")

    MazeRenderer(problem).render(image_path)
    validation = validate_problem(problem)
    validation_path.write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    if not validation["valid"]:
        raise MazeError(f"Saved problem failed validation: {validation['errors']}")

    return {
        "problem_id": problem.problem_id,
        "seed": str(problem.seed),
        "json": json_path.relative_to(output_directory).as_posix(),
        "map_txt": map_path.relative_to(output_directory).as_posix(),
        "answer_txt": answer_path.relative_to(output_directory).as_posix(),
        "png": image_path.relative_to(output_directory).as_posix(),
        "validation_json": validation_path.relative_to(output_directory).as_posix(),
    }


def load_problem(path: str | Path) -> MazeProblem:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return MazeProblem(**data)


def generate_problem_set(
    count: int,
    width: int,
    height: int,
    wall_density: float,
    image_size: int,
    output_directory: str | Path,
    prefix: str = "maze",
    start_side: Optional[str] = None,
    goal_side: Optional[str] = None,
) -> List[Dict[str, str]]:
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)

    manifest: List[Dict[str, str]] = []
    for index in range(count):
        generator = MazeGenerator(
            width=width,
            height=height,
            wall_density=wall_density,
            image_size=image_size,
            seed=None,
        )
        problem_id = f"{prefix}_{index + 1:03d}"
        problem = generator.generate(problem_id=problem_id, start_side=start_side, goal_side=goal_side)
        manifest.append(save_problem(problem, output_directory))

    manifest_path = output_directory / f"{prefix}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def score_set(manifest_path: str | Path, logs: Dict[str, str]) -> Dict:
    manifest_path = Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    per_problem = []
    for item in manifest:
        problem_id = item["problem_id"]
        problem = load_problem(manifest_path.parent / item["json"])
        _, grading = MazeScorer(problem).grade_log(logs.get(problem_id, ""))
        per_problem.append(grading)

    count = len(per_problem)
    return {
        "summary": {
            "problem_count": count,
            "mean_score": sum(item["score"] for item in per_problem) / count if count else 0.0,
            "completion_rate": sum(bool(item["success"]) for item in per_problem) / count if count else 0.0,
            "collision_rate": sum(bool(item["death"]) for item in per_problem) / count if count else 0.0,
            "mean_completion_ratio": sum(item["completion_ratio"] for item in per_problem) / count if count else 0.0,
            "mean_efficiency_ratio": sum(item["efficiency_ratio"] for item in per_problem) / count if count else 0.0,
        },
        "results": per_problem,
    }


def build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate and score visual maze benchmarks")
    commands = parser.add_subparsers(dest="command", required=True)

    generate = commands.add_parser("generate", help="Generate a maze problem set")
    generate.add_argument("--width", type=int, required=True)
    generate.add_argument("--height", type=int, required=True)
    generate.add_argument("--wall-density", type=float, default=0.70)
    generate.add_argument("--image-size", type=int, default=2048)
    generate.add_argument("--count", type=int, default=1)
    generate.add_argument("--out-dir", default="maze_out")
    generate.add_argument("--prefix", default="maze")
    generate.add_argument("--start-side", choices=list(VALID_SIDES))
    generate.add_argument("--goal-side", choices=list(VALID_SIDES))

    score = commands.add_parser("score", help="Score one model output")
    score.add_argument("--problem-json", required=True)
    score_input = score.add_mutually_exclusive_group(required=True)
    score_input.add_argument("--log")
    score_input.add_argument("--log-file")

    validate = commands.add_parser("validate", help="Validate one generated problem JSON")
    validate.add_argument("--problem-json", required=True)

    score_many = commands.add_parser("score-set", help="Score outputs for a whole manifest")
    score_many.add_argument("--manifest", required=True)
    score_many.add_argument("--logs-json", required=True)
    score_many.add_argument("--output")

    return parser


def main() -> None:
    args = build_cli().parse_args()

    if args.command == "generate":
        manifest = generate_problem_set(
            count=args.count,
            width=args.width,
            height=args.height,
            wall_density=args.wall_density,
            image_size=args.image_size,
            output_directory=args.out_dir,
            prefix=args.prefix,
            start_side=args.start_side,
            goal_side=args.goal_side,
        )
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return

    if args.command == "score":
        problem = load_problem(args.problem_json)
        scorer = MazeScorer(problem)
        text = Path(args.log_file).read_text(encoding="utf-8") if args.log_file else args.log
        _, grading = scorer.grade_log(text)
        print(json.dumps(grading, ensure_ascii=False, indent=2))
        return

    if args.command == "validate":
        problem = load_problem(args.problem_json)
        result = validate_problem(problem)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if not result["valid"]:
            raise SystemExit(1)
        return

    if args.command == "score-set":
        logs = json.loads(Path(args.logs_json).read_text(encoding="utf-8"))
        result = score_set(args.manifest, logs)
        rendered = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            Path(args.output).write_text(rendered, encoding="utf-8")
        print(rendered)
        return


if __name__ == "__main__":
    main()
