import Link from "next/link";

export default function NotFound() {
  return (
    <div className="stack" style={{ alignItems: "flex-start" }}>
      <div className="kicker">404</div>
      <h1 style={{ margin: 0 }}>This page is off the flat world.</h1>
      <p className="lede">The route does not exist. The exchange desk, the $WIF flywheel and the judge tour are one click away.</p>
      <div className="row">
        <Link className="btn" href="/">Exchange Desk</Link>
        <Link className="btn ghost" href="/tour">▶ 60-Second Judge Tour</Link>
      </div>
    </div>
  );
}
