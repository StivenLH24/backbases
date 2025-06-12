const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const oracledb = require("oracledb");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

async function getConnection() {
  return await oracledb.getConnection({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    connectString: process.env.DB_CONNECT,
  });
}

// Registro
app.post("/register", async (req, res) => {
  const { cedula, nombre, apellido, contrasena } = req.body;
  const hashed = await bcrypt.hash(contrasena, 10);
  const conn = await getConnection();

  try {
    await conn.execute(
      `INSERT INTO usuarios (cedula, nombre, apellido, contrasena) VALUES (:c, :n, :a, :p)`,
      [cedula, nombre, apellido, hashed],
      { autoCommit: true }
    );
    res.json({ mensaje: "Usuario registrado" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Login
app.post("/login", async (req, res) => {
  const { cedula, contrasena } = req.body;
  const conn = await getConnection();

  try {
    const result = await conn.execute(
      `SELECT cedula, contrasena FROM usuarios WHERE cedula = :c`,
      [cedula]
    );

    const usuario = result.rows[0];
    if (!usuario || !(await bcrypt.compare(contrasena, usuario[1]))) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign({ cedula }, process.env.JWT_SECRET);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Middleware para verificar token
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.sendStatus(401);

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.sendStatus(403);
  }
}

// Votar
app.post("/votar", auth, async (req, res) => {
  const { id_votacion, id_opcion } = req.body;
  const cedula = req.user.cedula;
  const conn = await getConnection();

  try {
    // Verificar si ya votó
    const check = await conn.execute(
      `SELECT 1 FROM votos WHERE cedula = :c`,
      [cedula]
    );
    if (check.rows.length > 0) {
      // Log de intento doble
      await conn.execute(
        `INSERT INTO auditoria_votos (id_log, cedula, id_votacion, id_opcion, evento)
         VALUES (seq_id_log.NEXTVAL, :c, :v, :o, 'Intento de voto duplicado')`,
        [cedula, id_votacion, id_opcion],
        { autoCommit: true }
      );
      return res.status(403).json({ error: "Ya votaste" });
    }

    // Insertar voto
    await conn.execute(
      `INSERT INTO votos (id_voto, cedula, id_votacion, id_opcion)
       VALUES (seq_id_voto.NEXTVAL, :c, :v, :o)`,
      [cedula, id_votacion, id_opcion]
    );

    // Log exitoso
    await conn.execute(
      `INSERT INTO auditoria_votos (id_log, cedula, id_votacion, id_opcion, evento)
       VALUES (seq_id_log.NEXTVAL, :c, :v, :o, 'Voto registrado')`,
      [cedula, id_votacion, id_opcion],
      { autoCommit: true }
    );

    res.json({ mensaje: "Voto registrado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Reporte
app.get("/resultados/:id_votacion", async (req, res) => {
  const id_votacion = req.params.id_votacion;
  const conn = await getConnection();

  try {
    const result = await conn.execute(
      `SELECT o.nombre_opcion, COUNT(*) AS votos
       FROM votos v
       JOIN opciones_votacion o ON v.id_opcion = o.id_opcion
       WHERE v.id_votacion = :v
       GROUP BY o.nombre_opcion`,
      [id_votacion]
    );

    const data = result.rows.map(([nombre, votos]) => ({
      nombre,
      votos,
    }));

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API lista en http://localhost:${PORT}`);
});
