/**
 * Receipt: a receipt slip printing from the slot of a low printer body.
 * The pointer pulls the slip: its top edge follows the pointer's height on
 * a spring, and a rule line appears for every six units printed. At rest a
 * short stub shows in the slot. The slider is the longest print.
 */
const {
  Cam, clamp, facing, fillet, fit, open, poly, prism, proj, ringAt, rings, rrect, seg,
  spring, stepS, disposer, mk, pointer, put, register, solid,
} = HL;

// Body 140 x 56, 14 tall; slot 52 x 12 on its top face; slip 44 wide at y=0.
const BX0 = -70, BY0 = -28, BX1 = 70, BY1 = 28, BH = 14;
const SLOT = 26, SLIP_W = 44, REST_H = 8, LINE_EVERY = 6;
const S = 1.8, ZPX = S * Math.sqrt(1 - 0.5 * 0.5);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let maxH = value;

  const C = Cam(45, 0.5, S);
  fit(C, [[BX0, BY0, 0], [BX1, BY1, 0], [BX1, BY0, 0], [BX0, BY1, 0], [BX0, BY0, BH], [BX1, BY1, BH], [0, 0, BH + 40], [-SLIP_W / 2, 0, BH + 40], [SLIP_W / 2, 0, BH + 40]], 200, 166);
  const P = proj(C), front = facing(C);
  const slotY = P(0, 0, BH)[1];

  const g = mk("g", {}, svg);
  const [br, bi] = rings(BX0, BY0, BX1, BY1, 10, 2);
  put(solid(g), prism(P, front, br, bi, 0, BH));
  // The slot, bright at rest; the slip is painted after it and covers its middle.
  const slot = mk("path", { d: open(ringAt(P, rrect(-SLOT, -6, SLOT, 6, 3, 5), BH)), class: "nf hi" }, g);

  const slipSp = spring(REST_H, { eps: 0.04 });
  const slipG = mk("g", {}, g);
  const slipFace = mk("path", { class: "sil" }, slipG);
  const slipRules = mk("path", { class: "nf lo" }, slipG);
  let drawn = NaN;
  function drawSlip() {
    const h = Math.max(2, slipSp.x);
    if (h === drawn) return;
    drawn = h;
    const w = (u, v) => P(-SLIP_W / 2 + u, 0, BH + v);
    // Torn top edge: the slip's top is a shallow zigzag, a mark the object
    // would really have.
    const top = [];
    let k = 0;
    for (let u = SLIP_W; u > 0; u -= 5.5) top.push([u, k++ % 2 === 0 ? h : h - 2]);
    const pts = [[0, 0], [SLIP_W, 0], ...top, [0, h]];
    const radii = pts.map((_, i) => (i < 2 ? 2 : 0.8));
    slipFace.setAttribute("d", poly(fillet(pts, radii).map((p) => w(p[0], p[1]))));
    const lines = [];
    for (let v = LINE_EVERY; v <= h - 2; v += LINE_EVERY) lines.push(v);
    slipRules.setAttribute("d", lines.map((v) => seg(w(5, v), w(SLIP_W - 5, v))).join(""));
    const n = lines.length;
    read.textContent = over ? "line " + String(n).padStart(2, "0") : "rest";
  }

  let over = false;
  const B = register(stage, (dt) => {
    const m = stepS(slipSp, dt);
    drawSlip();
    return m;
  });
  bag.add(B.unregister);

  function retarget(p) {
    // The slip's top follows the pointer's height: one world unit up is
    // ZPX screen units, so the paper tracks the hand exactly.
    slipSp.t = clamp((slotY - p[1]) / ZPX, 0, maxH);
    B.wake();
  }

  bag.add(pointer(stage, {
    move: (p) => {
      if (!over) { over = true; slipFace.classList.toggle("hi", true); slot.classList.toggle("hi", false); }
      retarget(p);
    },
    leave: () => {
      over = false;
      slipSp.t = REST_H;
      slipFace.classList.toggle("hi", false);
      slot.classList.toggle("hi", true);
      B.wake();
    },
  }));
  drawSlip();
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { maxH = v; slipSp.t = Math.min(slipSp.t, maxH); B.wake(); },
    destroy: bag.dispose,
  };
}

hairline({
  name: "receipt",
  means: "A receipt printing from its slot: pull the pointer up and the slip prints longer.",
  rules: [1, 3, 5, 8, 10],
  range: [12, 26, 40],
  tour: [[200, 162], [177, 142], [223, 121], null],
  mount,
});
