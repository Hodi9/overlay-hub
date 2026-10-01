// "!subgoal 500" sets the goal, "!subgoal +10" / "!subgoal -5" nudges it.
// Returns the new goal, or null if the message isn't a valid goal command.
export function parseGoalCommand(message, command, currentGoal = 0) {
  const parts = String(message || "").trim().toLowerCase().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== command.toLowerCase()) return null;
  const match = /^([+-]?)(\d{1,7})$/.exec(parts[1]);
  if (!match) return null;
  const amount = Number(match[2]);
  const goal = match[1] === "+" ? currentGoal + amount : match[1] === "-" ? currentGoal - amount : amount;
  return Math.max(0, goal);
}

export function isModOrBroadcaster(tags) {
  if (tags.badges?.broadcaster === "1") return true;
  if (tags.mod) return true;
  return String(tags["user-type"] || "").toLowerCase() === "mod";
}
