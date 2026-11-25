// Payable: five invoice sheets in a tray (the riffle pattern). The sheet
// under the pointer lifts; press it to pay, and a receipt slip rises.
// The slider is the stagger, in ms.
const {
  Cam, clamp, facing, fillet, fit, hull, open, poly, proj, rad, ringAt, rrect, run, seg,
  spring, stepS, tdone, tset, tval, tween, disposer, mk, place, pointer, reflect, register,
} = HL;

const N = 5, W = 84, H = 54, G = 13, TW = 22, TH = 7, TABS = [6, 31, 56], TK = 1.4;
const REST = -12, BACK = -24, FWD = 20, LIFT = 16;
const X0 = -5, X1 = W + 5, Y0 = -9, Y1 = (N - 1) * G + 9, WH = 20, WR = 6, WT = 2.4;
// The receipt slip: a narrow plate at the back-right of the tray, rising on
// a spring. At rest it sits below the tray's rim (hidden); paid, its top
// clears the sheets.
const SX0 = 56, SX1 = 88, SY = -5, RH = 40, SLIP_REST = -24, SLIP_PAID = 28; // slip: narrow plate, back-right

/** A run of points ordered left to right on screen. */
const LR = (pts) => (pts[0][0] <= pts[pts.length - 1][0] ? pts : pts.slice().reverse());

/** The tray, which never moves: `far` is painted before the sheets, `near` after them. */
function tray(P, front, outer, inner) {
  const far = [
    [poly(hull(ringAt(P, outer, 0).concat(ringAt(P, outer, WH)))), "sil"],
    [poly(ringAt(P, inner, WH)), "nf"],
    [open(ringAt(P, run(inner, (q) => !front(q)), 2.5)), "nf lo"],
  ];
  const iF = LR(ringAt(P, run(inner, front), WH)), oT = LR(ringAt(P, run(outer, front), WH)), oB = LR(ringAt(P, run(outer, front), 0));
  const hx = (X0 + X1) / 2, onFront = (ring) => ring.map((q) => P(q.u, Y1, q.v));
  const near = [
    [poly([...iF, oT[oT.length - 1], ...oB.slice().reverse(), oT[0]]), "fo"],
    [open(oT), "nf lo"],
    [open(iF), "nf"],
    [open([oT[0], ...oB, oT[oT.length - 1]]), "nf sil"],
    [poly(onFront(rrect(hx - 11, 6.5, hx + 11, 12.5, 3, 5))), "nf"],
    [poly(onFront(rrect(hx - 9.4, 8, hx + 9.4, 11, 1.5, 5))), "nf lo"],
  ];
  return { far, near };
}

/** Sheet i, back to front: its number, which of three tab positions it takes, and its filleted outline. */
function card(i) {
  const n = N - i, t0 = TABS[(N - 1 - i) % 3];
  const shape = fillet(
    [[0, 0], [W, 0], [W, H], [t0 + TW, H], [t0 + TW, H + TH], [t0, H + TH], [t0, H], [0, H]],
    [1, 1, 3.2, 1.8, 2.4, 2.4, 1.8, 3.2],
  );
  return { n, t0, shape };
}

/** Sheet i leaning th degrees and lifted by `lift`: its paths, and where its eight punches sit. */
function pose(P, i, t0, shape, th, lift) {
  const yb = i * G, s = Math.sin(rad(th)), c = Math.cos(rad(th));
  const w = (u, v) => P(u, yb + v * s, v * c + lift);
  const wb = (u, v) => P(u, yb + v * s - TK * c, v * c + TK * s + lift);
  const punch = [];
  for (let k = 0; k < 8; k++) punch.push(w(t0 + TW / 2 + ((k % 4) - 1.5) * 3.6, H + TH / 2 + (0.5 - Math.floor(k / 4)) * 2.8));
  return {
    back: poly(shape.map((p) => wb(p[0], p[1]))), face: poly(shape.map((p) => w(p[0], p[1]))),
    head: seg(w(6, H - 11), w(W - 6, H - 11)),
    rules: [H - 18, H - 25, H - 32, H - 39].map((v) => seg(w(6, v), w(W - 6, v))).join(""), punch,
  };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value;

  // Fitted to the tray with a sheet lifted and the slip raised, so nothing
  // leaves the frame in any pose.
  const C = Cam(45, 0.5, 2.0);
  fit(C, [[X0, Y0, 0], [X1, Y1, -8], [X1, Y0, 0], [X0, Y1, 0], [X0, Y0, H + TH], [X1, Y0, H + TH + LIFT], [SX0, SY, SLIP_PAID + RH], [SX1, SY, SLIP_PAID + RH]], 200, 166);
  const P = proj(C), front = facing(C);
  const outer = rrect(X0, Y0, X1, Y1, WR, 6), inner = rrect(X0 + WT, Y0 + WT, X1 - WT, Y1 - WT, WR - WT, 6);
  const paths = tray(P, front, outer, inner);

  const g = mk("g", {}, svg);
  reflect(svg, g, P, front, outer, 0, 14);
  for (const [d, cls] of paths.far) mk("path", { d, class: cls }, g);

  const slipShape = fillet([[0, 0], [SX1 - SX0, 0], [SX1 - SX0, RH], [0, RH]], [2, 2, 2, 2]);
  const slipSp = spring(SLIP_REST, { eps: 0.04 });
  const slipG = mk("g", {}, g);
  const slipFace = mk("path", { class: "sil" }, slipG);
  const slipRules = mk("path", { class: "nf lo" }, slipG);
  const slipDot = mk("circle", { r: 1.4, class: "dot off" }, slipG);
  let slipDrawn = NaN;
  function drawSlip() {
    const lift = slipSp.x;
    if (lift === slipDrawn) return;
    slipDrawn = lift;
    const w = (u, v) => P(SX0 + u, SY, v + lift);
    slipFace.setAttribute("d", poly(slipShape.map((p) => w(p[0], p[1]))));
    slipRules.setAttribute("d", [8, 16, 24, 32].map((v) => seg(w(5, v), w(SX1 - SX0 - 5, v))).join(""));
    place(slipDot, w((SX1 - SX0) / 2, RH - 6));
  }

  const cards = [];
  for (let i = 0; i < N; i++) {
    const { n, t0, shape } = card(i);
    const grp = mk("g", {}, g);
    const back = mk("path", { class: "lo" }, grp), face = mk("path", { class: "sil" }, grp);
    const head = mk("path", { class: "nf" }, grp), rules = mk("path", { class: "nf lo" }, grp);
    const punch = [];
    for (let k = 0; k < 8; k++) punch.push(mk("circle", { r: 1.05, class: "dot " + (k === n - 1 ? "m" : "off") }, grp));
    cards.push({ n, t0, shape, back, face, head, rules, punch, a: tween(REST), z: tween(0) });
  }

  for (const [d, cls] of paths.near) mk("path", { d, class: cls }, g);

  // Hit bands: oblique strips along the RESTING top edges. They never move.
  const top = (i) => P(W / 2, i * G + H * Math.sin(rad(REST)), H * Math.cos(rad(REST)));
  const c0 = top(0), c1 = top(1), d = [c1[0] - c0[0], c1[1] - c0[1]];
  const px0 = P(0, 0, 0), px1 = P(1, 0, 0), ex = [px1[0] - px0[0], px1[1] - px0[1]];
  const HALF = W / 2 + 6, det = d[0] * ex[1] - d[1] * ex[0];

  function hit([x, y]) { // the sheet whose band holds the point; -1 outside
    const qx = x - c0[0], qy = y - c0[1];
    const s = (qx * ex[1] - qy * ex[0]) / det, r = (d[0] * qy - d[1] * qx) / det;
    if (Math.abs(r) > HALF || s < -0.5 || s > N + 1) return -1;
    return clamp(Math.round(s), 0, N - 1);
  }

  function draw(i, th, lift) {
    const cd = cards[i], q = pose(P, i, cd.t0, cd.shape, th, lift);
    cd.back.setAttribute("d", q.back);
    cd.face.setAttribute("d", q.face);
    cd.head.setAttribute("d", q.head);
    cd.rules.setAttribute("d", q.rules);
    cd.punch.forEach((el, k) => place(el, q.punch[k]));
  }

  const B = register(stage, (dt, now) => {
    let moving = false;
    cards.forEach((cd, i) => { draw(i, tval(cd.a, now), tval(cd.z, now)); if (!tdone(cd.a, now) || !tdone(cd.z, now)) moving = true; });
    if (stepS(slipSp, dt)) moving = true;
    drawSlip();
    return moving;
  });
  bag.add(B.unregister);

  let act = -1, paid = -1;
  const num = (a) => String(N - a).padStart(2, "0");
  /** Lifts sheet a (-1 puts them all back); the stagger spreads from the sheet touched. */
  function setActive(a) {
    if (a === act) return;
    const now = performance.now(), from = a >= 0 ? a : act;
    act = a;
    cards.forEach((cd, i) => {
      const delay = Math.abs(i - from) * stag, th = a < 0 ? REST : i < a ? BACK : i > a ? FWD : 0;
      tset(cd.a, th, now, delay); tset(cd.z, a === i ? LIFT : 0, now, delay);
    });
    read.textContent = paid >= 0 ? "receipt " + num(paid) : a < 0 ? "rest" : "sheet " + num(a);
    B.wake();
  }
  /** Pays sheet a: the bright moves to it and the receipt slip rises. */
  function pay(a) {
    if (a < 0) return;
    paid = a;
    slipSp.t = SLIP_PAID;
    cards.forEach((cd, i) => {
      cd.face.classList.toggle("hi", i === a); cd.head.classList.toggle("hi", i === a);
      cd.punch[cd.n - 1].classList.toggle("m", i !== a);
    });
    slipFace.classList.toggle("hi", true);
    slipDot.setAttribute("class", "dot");
    read.textContent = "receipt " + num(a);
    B.wake();
  }
  function rest() {
    paid = -1;
    slipSp.t = SLIP_REST;
    cards.forEach((cd) => { cd.face.classList.toggle("hi", false); cd.head.classList.toggle("hi", false); });
    slipFace.classList.toggle("hi", false);
    slipDot.setAttribute("class", "dot off");
    setActive(-1);
  }

  bag.add(pointer(stage, {
    move: (p) => setActive(hit(p)),
    down: (p) => pay(hit(p)),
    leave: () => rest(),
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { stag = v; },
    destroy: bag.dispose,
  };
}

hairline({
  name: "payable",
  means: "Five invoice sheets in a tray: lift one, press it to pay, and the receipt slip rises.",
  rules: [1, 2, 4, 8, 10],
  range: [0, 40, 90],
  tour: [[179, 131], [216, 112], [253, 94], null],
  mount,
});
