Find the command sequence that moves from the blue arrow, which marks the starting point, to the red arrow, which marks the destination, in the attached maze image.

## Rules

- The starting point and destination are outside the maze.
- The first command must be S. It represents entering the maze from outside.
- All subsequent commands are relative to the direction you are currently facing.
- At every junction, corner, and dead end encountered along the route, output one of the following movement commands: straight (S), right (R), left (L), or back (B).
- At a corner, output L or R even if it is the only open direction. At a dead end, output B.
- Straight corridors are traversed automatically until the next decision point.
- Reaching the destination in fewer commands earns a higher score.
- Choosing a direction blocked by a wall results in failure.
- From the final interior cell directly in front of the exit, output one last command toward the exit marked by the red arrow to leave the maze.

## Output Format

- Output only the commands S, R, B, and L, separated by spaces.
- Do not output explanations, reasoning, coordinates, or code blocks.
- Example: `S S R S L R`
