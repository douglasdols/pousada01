const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const clean = (value) => String(value ?? "").trim();
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const today = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const validStay = (checkin, checkout) => validDate(checkin) && validDate(checkout)
  && checkin >= today() && (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000 >= 1
  && (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000 <= 30;

async function readBody(request) {
  const text = await request.text();
  if (text.length > 12000) throw Object.assign(new Error("Requisição muito grande"), { status: 413 });
  try { return JSON.parse(text || "{}"); }
  catch { throw Object.assign(new Error("JSON inválido"), { status: 400 }); }
}

async function supabase(env, route, { method = "GET", data, token, apiKey } = {}) {
  const key = apiKey || env.SUPABASE_SECRET_KEY;
  const bearer = token || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${route}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...(method === "PATCH" ? { Prefer: "return=representation" } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : null; }
  catch { result = { message: text }; }
  if (!response.ok) {
    const error = new Error(result?.message || result?.error_description || "Falha no banco de dados");
    error.status = response.status;
    error.code = result?.code;
    throw error;
  }
  return result;
}

async function requireAdmin(request, env) {
  const authorization = request.headers.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)) {
    throw Object.assign(new Error("Faça login para continuar"), { status: 401 });
  }
  const token = authorization.slice(7);
  const user = await supabase(env, "/auth/v1/user", { token, apiKey: env.SUPABASE_PUBLISHABLE_KEY });
  if (!user?.id) throw Object.assign(new Error("Sessão inválida"), { status: 401 });
  const admins = await supabase(env, `/rest/v1/pb_admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (!admins.length) throw Object.assign(new Error("Usuário sem permissão administrativa"), { status: 403 });
  return user;
}

async function api(request, env, url) {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SECRET_KEY) {
    return json(503, { error: "Integração Supabase incompleta." });
  }
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/rooms") {
    const checkin = url.searchParams.get("checkin");
    const checkout = url.searchParams.get("checkout");
    const guests = Number(url.searchParams.get("guests") || 2);
    const datesValid = validStay(checkin, checkout);
    const rooms = await supabase(env, "/rest/v1/pb_rooms?select=*&active=eq.true&order=price.desc");
    const bookings = datesValid ? await supabase(env,
      `/rest/v1/pb_bookings?select=room_id,checkin,checkout,status&status=in.(pending,confirmed)&checkin=lt.${encodeURIComponent(checkout)}&checkout=gt.${encodeURIComponent(checkin)}`) : [];
    const nights = datesValid ? (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000 : null;
    return json(200, { demo: false, rooms: rooms.map((room) => ({
      id: room.id, name: room.name, type: room.type, description: room.description,
      capacity: room.capacity, units: room.units, price: Number(room.price), amenities: room.amenities,
      image: room.image,
      available: datesValid ? (Number.isInteger(guests) && guests >= 1 && guests <= room.capacity
        ? Math.max(0, Number(room.units) - bookings.filter((booking) => booking.room_id === room.id).length) : 0) : room.units,
      nights, total: nights === null ? null : nights * Number(room.price),
    })) });
  }
  if (request.method === "POST" && path === "/api/bookings") {
    const body = await readBody(request);
    if (!validStay(body.checkin, body.checkout) || !body.acceptedTerms
      || !Number.isInteger(Number(body.guests)) || clean(body.name).length < 3 || clean(body.name).length > 200
      || clean(body.email).length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(body.email))
      || clean(body.phone).replace(/\D/g, "").length < 10 || clean(body.phone).length > 50
      || clean(body.notes).length > 200) return json(400, { error: "Revise datas, contato e aceite das condições." });
    const result = await supabase(env, "/rest/v1/rpc/pb_create_booking", { method: "POST", data: {
      p_room_id: clean(body.roomId), p_checkin: body.checkin, p_checkout: body.checkout,
      p_guests: Number(body.guests), p_name: clean(body.name), p_email: clean(body.email),
      p_phone: clean(body.phone), p_notes: clean(body.notes),
    } });
    return json(201, result);
  }
  if (request.method === "POST" && path === "/api/admin/login") {
    const body = await readBody(request);
    if (!clean(body.email) || !body.password) return json(400, { error: "Informe e-mail e senha." });
    const session = await supabase(env, "/auth/v1/token?grant_type=password", {
      method: "POST", data: { email: clean(body.email), password: body.password },
      token: env.SUPABASE_PUBLISHABLE_KEY, apiKey: env.SUPABASE_PUBLISHABLE_KEY,
    });
    await requireAdmin(new Request(request.url, { headers: { authorization: `Bearer ${session.access_token}` } }), env);
    return json(200, { access_token: session.access_token, expires_in: session.expires_in });
  }
  if (path.startsWith("/api/admin/")) {
    await requireAdmin(request, env);
    if (request.method === "GET" && path === "/api/admin/bookings") {
      const bookings = await supabase(env, "/rest/v1/pb_bookings?select=*&order=created_at.desc&limit=500");
      return json(200, { bookings: bookings.map((booking) => ({
        id: booking.id, roomId: booking.room_id, roomName: booking.room_name,
        checkin: booking.checkin, checkout: booking.checkout, nights: booking.nights,
        guests: booking.guests, name: booking.name, email: booking.email, phone: booking.phone,
        notes: booking.notes, total: Number(booking.total), status: booking.status, createdAt: booking.created_at,
      })) });
    }
    if (request.method === "PATCH" && /^\/api\/admin\/bookings\/[^/]+$/.test(path)) {
      const body = await readBody(request);
      const id = decodeURIComponent(path.split("/").pop());
      return json(200, await supabase(env, "/rest/v1/rpc/pb_set_booking_status", {
        method: "POST", data: { p_id: id, p_status: body.status },
      }));
    }
    if (request.method === "GET" && path === "/api/admin/rooms") {
      return json(200, { rooms: await supabase(env, "/rest/v1/pb_rooms?select=*&order=price.desc") });
    }
    if (request.method === "PATCH" && /^\/api\/admin\/rooms\/[a-z0-9-]+$/.test(path)) {
      const body = await readBody(request);
      const id = path.split("/").pop();
      const data = {};
      if (body.price !== undefined) {
        if (!Number.isFinite(Number(body.price)) || Number(body.price) < 0 || Number(body.price) > 1000000) return json(400, { error: "Tarifa inválida" });
        data.price = Number(body.price);
      }
      if (body.units !== undefined) {
        if (!Number.isInteger(Number(body.units)) || Number(body.units) < 0 || Number(body.units) > 100) return json(400, { error: "Unidades inválidas" });
        data.units = Number(body.units);
      }
      if (body.active !== undefined) {
        if (typeof body.active !== "boolean") return json(400, { error: "Estado inválido" });
        data.active = body.active;
      }
      if (!Object.keys(data).length) return json(400, { error: "Nenhuma alteração" });
      const result = await supabase(env, `/rest/v1/pb_rooms?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", data });
      return json(200, { room: result?.[0] || null });
    }
  }
  return json(404, { error: "Rota não encontrada" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "86400",
    } });
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (!env.ASSETS) return new Response("Assets binding ausente.", { status: 503 });
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const status = error.code === "P0001" ? 409 : error.code === "22023" ? 400
        : error.code === "P0002" ? 404 : [400, 401, 403, 413].includes(error.status) ? error.status : 502;
      return json(status, { error: status === 502 ? "Não foi possível consultar o serviço de reservas." : error.message });
    }
  },
};
