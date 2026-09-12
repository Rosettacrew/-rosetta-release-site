/**
 * Default categories + sample goals/tasks/pins for first load.
 */
(function (global) {
  const DEFAULT_CATEGORIES = [
    { id: 'cat_rosetta', name: 'Rosetta Crew OS', color: '#c9a227', order: 0 },
    { id: 'cat_music', name: 'Music releases', color: '#7c9cff', order: 1 },
    { id: 'cat_beatbay', name: 'BeatBay', color: '#5ecf8a', order: 2 },
    { id: 'cat_games', name: 'Games', color: '#e07a5f', order: 3 },
    { id: 'cat_personal', name: 'Personal goals', color: '#b48ead', order: 4 },
    { id: 'cat_other', name: 'Other', color: '#888890', order: 5 }
  ];

  function todayISO() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  async function ensureSeeded() {
    const seeded = await VBDB.getMeta('seeded');
    if (seeded) return false;

    const cats = await VBDB.getAll('categories');
    if (!cats.length) {
      for (const c of DEFAULT_CATEGORIES) await VBDB.put('categories', { ...c });
    }

    const t = todayISO();

    const g1 = await VBDB.put('goals', {
      id: 'goal_sample_1',
      title: 'Ship Rosetta Crew OS MVP',
      description: 'Core planning + vision tools live',
      categoryId: 'cat_rosetta',
      target: 5,
      current: 1,
      unit: 'milestones',
      status: 'active',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const g2 = await VBDB.put('goals', {
      id: 'goal_sample_2',
      title: 'Next music release prep',
      description: 'Tracks mixed & cover art ready',
      categoryId: 'cat_music',
      target: 4,
      current: 0,
      unit: 'tasks',
      status: 'active',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const g3 = await VBDB.put('goals', {
      id: 'goal_sample_3',
      title: 'BeatBay catalog polish',
      description: 'Listings and tags cleaned up',
      categoryId: 'cat_beatbay',
      target: 10,
      current: 3,
      unit: 'items',
      status: 'active',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('items', {
      id: 'item_sample_1',
      title: 'Review Today dashboard',
      type: 'task',
      date: t,
      done: false,
      goalId: g1.id,
      categoryId: 'cat_rosetta',
      notes: 'Sample — complete me to bump goal progress',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('items', {
      id: 'item_sample_2',
      title: 'Sketch release checklist',
      type: 'task',
      date: t,
      done: false,
      goalId: g2.id,
      categoryId: 'cat_music',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('items', {
      id: 'item_sample_3',
      title: 'BeatBay sync call',
      type: 'appointment',
      date: addDays(t, 2),
      time: '15:00',
      done: false,
      categoryId: 'cat_beatbay',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('items', {
      id: 'item_sample_4',
      title: 'Demo build deadline',
      type: 'deadline',
      date: addDays(t, 5),
      done: false,
      goalId: g1.id,
      categoryId: 'cat_rosetta',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('items', {
      id: 'item_sample_5',
      title: 'Vision board live',
      type: 'milestone',
      date: t,
      done: true,
      goalId: g1.id,
      categoryId: 'cat_rosetta',
      sample: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await VBDB.put('pins', {
      id: 'pin_sample_1',
      text: 'Rosetta Crew — build in public, ship often',
      imageUrl: '',
      x: 8,
      y: 12,
      color: '#c9a227',
      sample: true,
      createdAt: Date.now()
    });

    await VBDB.put('pins', {
      id: 'pin_sample_2',
      text: 'Music that moves people',
      imageUrl: '',
      x: 42,
      y: 28,
      color: '#7c9cff',
      sample: true,
      createdAt: Date.now()
    });

    await VBDB.put('pins', {
      id: 'pin_sample_3',
      text: 'BeatBay · Games · Personal balance',
      imageUrl: '',
      x: 18,
      y: 55,
      color: '#5ecf8a',
      sample: true,
      createdAt: Date.now()
    });

    await VBDB.setMeta('seeded', true);
    return true;
  }

  global.VBSeed = { DEFAULT_CATEGORIES, ensureSeeded };
})(typeof window !== 'undefined' ? window : self);
