# Holotable

Build NPC scenarios for Movie Battles II servers on a top-down map of any map
in the game - place spawn points, patrol routes and trigger areas, design your
own NPCs, and chain up what happens: *a player walks into the hangar → droids
pour in → all down → "Reinforcements!" → wave two → the end.*

Scenarios are saved as JSON into the game folder, where a server with the
Clone Army OpenJK engine and MBIIEZ's Holotable plugin picks them up. In game, log in and type `!ht` to list
the scenarios for the map that's on, then `!ht <n> play` (admins) to run one.
Saved a change while it's running? `!ht restart` reloads it from the file and starts it over.

## What's in it

- **The map, from the map itself.** Holotable reads the map's `.bsp` straight
  out of the game's pk3s and draws its floors and walls from above - exact
  coordinates, any map, nothing to calibrate. A **cut height** slider lifts off
  everything above it (floors just under the cut are bright, lower ones fade),
  so stacked rooms and balconies can be worked on one at a time.
- **Places.** Points (with a facing), routes (loops NPCs walk) and areas
  (trigger zones). Click to place; each lands on the floor under the cut, and
  you can drag to move. Route legs that go through a wall show red.
- **NPC types.** Pick a model and skin (every player model in the game, with
  its icon where there is one), weapon, health, armour, size, skill and speed.
  They're written to `ext_data/NPCs/holotable.npc`; MBII reads NPC files when
  a map loads, so **new or changed types work after the server's next map
  change**. Groups can also use any NPC type the game already has.
- **Groups.** Which NPC types, how many (scaling with players if you like), a
  leader, where they spawn (a point, or along a route), how they behave -
  *hunt*, *route* (walk a route, fight whoever comes close), *guard* (hold the
  spawn) or *idle* - and who they attack: everyone, or one side only (they
  fight for the other - allies for the players on it).
- **Triggers.** When: the start, a timer, a player entering an area, a group
  wiped out, everyone down, or some seconds after another trigger. Then: spawn
  a group, an NPC says something (a chat line under their name, with a voice
  sound - search the game's 24,000 sounds and listen in the browser), a chat or
  centre message, a sound, music, or end it.
- **Players.** Either side as normal, or co-op: everyone on one side (the map's
  own names for them), team balance off. Anytime spawn lets players join any
  time and respawn a few seconds after dying, while the scenario runs.
- **Checks.** What's missing or likely to go wrong, before you try it.
- **Accounts.** The first admin comes from `.env`; admins add more on the Users
  page. Each scenario belongs to whoever made it: editors see and edit only
their own, admins see all of them (and can hand one to someone else). In game,
every scenario for the map is listed. An account can be linked
  to its owner's in-game account and ticked **Runs scenarios**: then they can
  `!ht play`, `!ht restart` and `!ht stop` in game without being a game admin
  (the handles go in `GAMEDATA/holotable_runners.dat`, which servers re-read
  every few seconds).

## Install

```sh
git clone https://github.com/clone-army/holotable
cd holotable
sudo ./install.sh
```

`install.sh` makes a Python virtualenv, copies `.env.example` to `.env` with a
random admin password (printed), and, as root with systemd, sets up and starts a
`holotable` service. Check `GAMEDATA` in `.env` points at your game folder
(`fs_basepath/fs_game`, e.g. `/opt/openjk/MBII`), then open
`http://your-server:8090`.

Settings are all in `.env` - see `.env.example`.

## The scenario format

One JSON file per scenario in `GAMEDATA/holotable/`:

```json
{
  "format": 1,
  "name": "Hangar ambush",
  "map": "uM_Cantina",
  "description": "Droids at the back door",
  "timeLimit": 900,
  "joinTeam": "team1",
  "anytimeSpawn": true,
  "respawnSeconds": 5,
  "points":   [{ "id": "p_x1", "name": "Back door", "x": 3987, "y": -1472, "z": -1716, "yaw": 90 }],
  "routes":   [{ "id": "r_x1", "name": "Round the bar", "points": [{ "x": 3999, "y": -1668, "z": -1728 }] }],
  "areas":    [{ "id": "a_x1", "name": "Bar", "x": 4008, "y": -550, "z": -1768, "radius": 200, "height": 128 }],
  "npcTypes": [{ "name": "HT_Commando", "model": "clonetrooper_p2", "skin": "arc_yellow", "weapon": "WP_CLONE_RIFLE",
                 "altFire": true, "health": 150, "armor": 50, "scale": 100, "skill": 4, "runSpeed": 230 }],
  "groups":   [{ "id": "g_x1", "name": "Droids", "npcs": ["CA_B1", "CA_B2"], "leader": "CA_Magna",
                 "count": 3, "perPlayer": 1, "max": 12, "spawn": "p_x1", "behaviour": "route", "route": "r_x1", "engage": 350 }],
  "triggers": [
    { "id": "t_x1", "name": "Ambush", "when": "enter_area", "area": "a_x1", "actions": [
        { "do": "say", "speaker": "Tactical Droid", "text": "Leave no survivors.", "path": "sound/chars/battledroid/misc/taunt.mp3" },
        { "do": "spawn", "group": "g_x1" } ] },
    { "id": "t_x2", "name": "Done", "when": "all_dead", "actions": [{ "do": "end", "text": "^2Cantina saved!" }] }
  ]
}
```

- `joinTeam`: `any` (either side, team balance as normal), or `team1` / `team2`
  for co-op - everyone on that side (the map's `.siege` names it, e.g. Jedi /
  Sith), team balance off, and anyone picking a class on the other side sent
  back to pick again. `anytimeSpawn`: players join any time and respawn
  `respawnSeconds` after dying. Both last only while the scenario runs, and the
  round clock is held open for its time limit.
- `when`: `start`; `timer` (`seconds` after the start); `enter_area` (`area` -
  a player walks in); `all_in_area` (`area` - every player is in it);
  `group_dead` (`group`); `group_left` (`group`, `count` or fewer left);
  `all_dead`; `npc_killed` (any scenario NPC); `player_died`; `players`
  (`count` or more in the game); `after` (`trigger`, `seconds` later);
  `counter` (`counter`, `compare` `>=` / `==` / `<=`, `count`); `countdown_end`.
  A trigger with `startOff` waits for a `trigger_on`.
- `counters`: `[{ "id", "name", "start" }]` - numbers triggers change and test.
- `repeat`: `false` fires once; `true` fires every time, no more often than
  `cooldown` seconds (a repeating `timer` goes off every `seconds`). Conditions
  fire as they become true.
- `do`:
  - `spawn` (`group`, `at` - a point, or along a route) / `despawn` (`group`) -
    bring a group in, or remove what's left of it. A group with `spawnAtStart`
    spawns at its `spawn` place as the scenario starts, without a trigger.
  - `say` (`speaker`, `text`, optional `path` voice sound) - an NPC's chat line, everyone
  - `tell` (`text`, `style` `center` or `chat`) - only the player who set it off
    (`enter_area` and `player_died` triggers)
  - `message` / `center` (`text`) - everyone
  - `explode` (`at`, `damage`, `radius`, `effect`, `path` sound) - hurts players
    and NPCs in range, less further out, and shakes the screen
  - `effect` (`at`, `effect`, optional `path`), `shake` (`at` or everywhere,
    `intensity`, `seconds`), `sound` (`path`, optional `at` - otherwise everyone)
  - `teleport` (`at`, `who` `player` or `all`)
  - `use` (`target`) - sets off the map's own entities with that targetname,
    as a button would: doors, lifts, relays
  - player actions, each with `who` - `player` (who set it off), `all`, `team1`,
    `team2` or an area id (everyone in it): `give` (`item`: a weapon `WP_...`,
    `health`, `armor`, `ammo`, or an item classname like `item_jetpack`),
    `heal`, `kill`, `knockdown` and `freeze` (`seconds`)
  - `vehicle` (`vehicle`, `at`) and `pickup` (`item` classname, `at`)
  - `move` (`group`, `behaviour`, `route` / `at`) - new orders for a group
  - `trigger_on` / `trigger_off` (`trigger`) - turning on also re-arms it
  - `counter` (`counter`, `op` `add` or `set`, `value`); `countdown`
    (`seconds`, `text`) - shown on everyone's screen
  - `objective` (`team`, `objective` number from the map's `.siege`) - completes
    the map's own objective; `texture` (`from`, `to` shaders) - swapped back at
    the end; `gravity` (`value`, normal 800) and `speed` (`value`, % of normal
    ground speed) for `seconds` (0 = till the end);
    `addtime` (`seconds` on or off the round clock)
  - `win` (`team`: `team1`, `team2` or `draw`, optional `text`) - ends the
    scenario, then the round, as if that side had won it
  - `music` (`path`), `end` (optional `text`)
- `at` is a point or area id, or `player` (where the player who set it off is).
  Effects are named as the game names them (`Grenades/EXP_BaseThermal`, no
  `effects/` or `.efx`).
- `attacks`: `all` (hostile to everyone), or `team1` / `team2` - only that
  side; the group fights for the other one, leaves its players alone, and
  fights groups on the opposite side.
- `behaviour`: `hunt`, `route`, `guard`, `idle`. `engage` is how close a
  player comes before a route walker or guard goes for them.
- Coordinates are the game's own (as `/viewpos` shows); `z` is the floor.

## The server side

The engine part lives in the Clone Army OpenJK fork (`codemp/server/social.cpp`,
"Holotable scenarios"): it lists `holotable/*.json` files for the current map
from every search path, and runs one on `!ht <n> play` - spawning, NPC
behaviour and triggers. It's on for any server with `g_holotable 1` - in
[MBIIEZ](https://github.com/clone-army/mbiiez), turn on the **Holotable** plugin
(on the server's Plugins page; it brings **Accounts** with it). Logging in is
`!login`, and admins are the accounts ticked on MBIIEZ's Accounts page. On a
social server only scenario NPCs and players hurt each other; elsewhere MBII's
usual damage rules apply. rcon `ht`, `ht <n> play`, `ht restart` and
`ht stop` do the same without logging in.
