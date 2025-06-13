const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const oracledb = require("oracledb");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Oracle Client
oracledb.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

// Función para obtener conexión
async function getConnection() {
  return await oracledb.getConnection({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    connectString: process.env.DB_CONNECT,
  });
}

// Registro de usuario
app.post("/register", async (req, res) => {
  const { cedula, nombre, apellido, contrasena } = req.body;
  const hashed = await bcrypt.hash(contrasena, 10);
  const conn = await getConnection();

  try {
    await conn.execute(
      `INSERT INTO USUARIOS (CEDULA, NOMBRE, APELLIDO, CONTRASENA) 
       VALUES (:c, :n, :a, :p)`,
      [cedula, nombre, apellido, hashed],
      { autoCommit: true }
    );
    res.json({ mensaje: "Usuario registrado exitosamente" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Login de usuario
app.post("/login", async (req, res) => {
  const { cedula, contrasena } = req.body;
  const conn = await getConnection();

  try {
    const result = await conn.execute(
      `SELECT CEDULA, CONTRASENA FROM USUARIOS WHERE CEDULA = :c`,
      [cedula]
    );

    const usuario = result.rows[0];
    if (!usuario || !(await bcrypt.compare(contrasena, usuario.CONTRASENA))) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = jwt.sign({ cedula }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Middleware de autenticación
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Acceso no autorizado" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.status(403).json({ error: "Token inválido o expirado" });
  }
}

// Endpoint para votar
app.post("/votar", auth, async (req, res) => {
  const { id_votacion, id_opcion } = req.body;
  const cedula = req.user.cedula;
  const conn = await getConnection();

  try {
    // Verificar si el usuario ya votó en esta votación
    const check = await conn.execute(
      `SELECT 1 FROM VOTOS 
       WHERE cedula = :c AND ID_VOTACION = :v`,
      [cedula, id_votacion]
    );
    
    if (check.rows.length > 0) {
      // Registrar intento de voto duplicado en auditoría
      await conn.execute(
        `INSERT INTO AUDITORIA_VOTOS 
         (ID_LOG, cedula, ID_VOTACION, ID_OPCION, FECHA_LOG, EVENTO)
         VALUES (seq_id_log.NEXTVAL, :c, :v, :o, SYSTIMESTAMP, 'Intento de voto duplicado')`,
        [cedula, id_votacion, id_opcion],
        { autoCommit: true }
      );
      return res.status(403).json({ error: "Ya has votado en esta votación" });
    }

    // Verificar si el usuario está bloqueado
    const bloqueoCheck = await conn.execute(
      `SELECT 1 FROM USUARIOS 
        WHERE cedula = :c AND estado = 'BLOQUEADO'`,
      [cedula]
    );
    
    if (bloqueoCheck.rows.length > 0) {
      await conn.execute(
        `INSERT INTO AUDITORIA_VOTOS 
         (ID_LOG, cedula, ID_VOTACION, ID_OPCION, FECHA_LOG, EVENTO)
         VALUES (seq_id_log.NEXTVAL, :c, :v, :o, SYSTIMESTAMP, 'Intento de voto bloqueado')`,
        [cedula, id_votacion, id_opcion],
        { autoCommit: true }
      );
      return res.status(403).json({ error: "Usuario bloqueado para votar" });
    }

    // Registrar el voto
    await conn.execute(
      `INSERT INTO VOTOS 
       (ID_VOTO, cedula, ID_VOTACION, ID_OPCION, FECHA_VOTO)
       VALUES (seq_id_voto.NEXTVAL, :c, :v, :o, SYSTIMESTAMP)`,
      [cedula, id_votacion, id_opcion],
      { autoCommit: true }
    );

    // Registrar auditoría de voto exitoso
    await conn.execute(
      `INSERT INTO AUDITORIA_VOTOS 
       (ID_LOG, cedula, ID_VOTACION, ID_OPCION, FECHA_LOG, EVENTO)
       VALUES (seq_id_log.NEXTVAL, :c, :v, :o, SYSTIMESTAMP, 'Voto registrado')`,
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

// Obtener resultados de votación
app.get("/resultados/:id_votacion", async (req, res) => {
  const id_votacion = req.params.id_votacion;
  const conn = await getConnection();

  try {
    const result = await conn.execute(
      `SELECT o.nombre_opcion AS nombre, COUNT(*) AS votos
       FROM VOTOS v
       JOIN OPCIONES_VOTACION o ON v.ID_OPCION = o.ID_OPCION
       WHERE v.ID_VOTACION = :v
       GROUP BY o.nombre_opcion`,
      [id_votacion]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Obtener votaciones activas
app.get("/votaciones/activas", async (req, res) => {
  const conn = await getConnection();
  
  try {
    const result = await conn.execute(
      `SELECT ID_VOTACION, TITULO, DESCRIPTION, 
              TO_CHAR(FECHA_INICIO, 'YYYY-MM-DD') AS FECHA_INICIO,
              TO_CHAR(FECHA_FIN, 'YYYY-MM-DD') AS FECHA_FIN
       FROM VOTACIONES
       WHERE ESTADO = 'ACTIVA' 
         AND FECHA_INICIO <= SYSDATE 
         AND FECHA_FIN >= SYSDATE`
    );
    
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Obtener opciones de votación
app.get("/opciones/:id_votacion", async (req, res) => {
  const id_votacion = req.params.id_votacion;
  const conn = await getConnection();
  
  try {
    const result = await conn.execute(
      `SELECT ID_OPCION, nombre_opcion, IMAGEN_URL
       FROM OPCIONES_VOTACION
       WHERE ID_VOTACION = :v`,
      [id_votacion]
    );
    
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});

// Nuevo endpoint para obtener votos por votación
app.get("/votos/:id_votacion", async (req, res) => {
  const id_votacion = req.params.id_votacion;
  const conn = await getConnection();

  try {
    const result = await conn.execute(
      `SELECT ID_OPCION FROM VOTOS WHERE ID_VOTACION = :v`,
      [id_votacion]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await conn.close();
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ API ejecutándose en http://localhost:${PORT}`);
});