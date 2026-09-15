const TIME_ZONE = "America/Sao_Paulo";

function isBusinessWindow() {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      hour12: false
    }).format(new Date())
  );

  return hour >= 7 && hour < 20;
}

export function startKeepAlive() {
  const url = process.env.KEEP_ALIVE_URL;

  if (!url) return;

  setInterval(async () => {
    if (!isBusinessWindow()) return;

    try {
      await fetch(url, { method: "GET" });
      console.log("[keep-alive] ping ok");
    } catch (error) {
      console.warn("[keep-alive] ping failed", error);
    }
  }, 10 * 60 * 1000);
}
