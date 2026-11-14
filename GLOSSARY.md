# Stage

Stage shows a house, or any set of things, in 3D and 2D from one scene file. An agent builds and changes the scene; a person looks at it in the viewer to see what the architects propose. It is a visual aid, not a record of the design.

## The scene and its sources

**Scene**:
The one file that describes everything shown: levels, rooms, openings, furniture and free objects.
_Avoid_: model, project

**Drawing**:
The architect's image of one level, laid under the plan so the walls can be checked against it.
_Avoid_: plan, plan image, underlay

**Drawing set**:
The group of drawings the architects deliver at one step of the design, such as a schematic design presentation or a set of construction drawings. The scene holds only what the drawing sets entered so far show.
_Avoid_: revision, package

**Source**:
Where a thing in the scene came from: a drawing set and page, or the agent.
_Avoid_: origin, provenance

**Addition**:
A thing the agent put in the scene that no drawing shows, such as furniture, a layout, or a guess where a drawing is unclear.
_Avoid_: suggestion, mock-up, extra

**Stated area**:
The area the architects print for a room on a drawing, which the scene's own area is checked against.
_Avoid_: official area, architect's area

## Looking at the scene

**Viewer**:
The page where a person looks at a scene. It never changes the scene; only the agent does.
_Avoid_: editor, app

**Mode**:
One of the four ways the viewer shows the scene: Plan, House, Room and Walk.
_Avoid_: view, camera

**Current room**:
The one room every mode centres on: the room the person picked, or in Walk mode the room they stand in. It stays the same when they change mode.
_Avoid_: selected room, focus

**Plan mode**:
The scene drawn from straight above as a 2D floor plan, with dimensions, and the drawing underneath when asked for.
_Avoid_: top view

**House mode**:
The whole house in 3D, seen from outside and circled around.
_Avoid_: overview, orbit

**Room mode**:
The current room on its own in 3D, circled from outside with a cutaway on the near walls.
_Avoid_: room view, dollhouse, focus

**Walk mode**:
Standing in the house at eye level and moving through it like a person.
_Avoid_: first person, walkthrough

**Place**:
A named spot in a room, set by the agent, to stand at and look from.
_Avoid_: camera, spot, viewpoint

**Room panel**:
The panel beside the scene that gives the facts about the current room, its room note and its places.
_Avoid_: card, info box, sidebar

**Cutaway**:
Walls between the camera and what it looks at, cut down so the person sees in.
_Avoid_: dollhouse, slice, section

## Reviewing

**Concept image**:
A photo from the architects' concept board that shows the mood intended for a room. It is not the design.
_Avoid_: render, inspiration, reference photo

**Room note**:
The one note a room carries from the person's review: their questions and remarks for the architects, kept by the agent. A room has at most one.
_Avoid_: sticky note, pin, comment, annotation
