const express = require('express');
const axios = require('axios');
const { db } = require('../../handlers/db.js');
const { logAudit } = require('../../handlers/auditlog');

const router = express.Router();

/**
 * Middleware to verify if the user is an administrator.
 * Checks if the user object exists and if the user has admin privileges. If not, redirects to the
 * home page. If the user is an admin, proceeds to the next middleware or route handler.
 *
 * @param {Object} req - The request object, containing user data.
 * @param {Object} res - The response object.
 * @param {Function} next - The next middleware or route handler to be executed.
 * @returns {void} Either redirects or proceeds by calling next().
 */
function isAdmin(req, res, next) {
    if (!req.user || req.user.admin !== true) {
      return res.redirect('../');
    }
    next();
}

/**
 * GET /instances/deploy
 * Handles the deployment of a new instance based on the parameters provided via query strings.
 */
router.get('/instances/deploy', isAdmin, async (req, res) => {
  const {
    image,
    memory,
    cpu,
    ports,
    nodeId,
    name,
    user,
    primary,
  } = req.query;

  if (!image || !memory || !cpu || !ports || !nodeId || !name || !user || !primary) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const node = await db.get(`${nodeId}_node`);
    if (!node) {
      return res.status(400).json({ error: 'Invalid node' });
    }

    const requestData = await prepareRequestData(image, memory, cpu, ports, name, node);
    const response = await axios(requestData);

    await updateDatabaseWithNewInstance(response.data, user, node, image, memory, cpu, ports, primary, name);

    logAudit(req.user.userId, req.user.username, 'instance:create', req.ip);
    res.status(201).json({
      message: 'Container created successfully and added to user\'s servers',
      containerId: response.data.containerId,
      volumeId: response.data.volumeId
    });
  } catch (error) {
    console.error('Error deploying instance:', error);
    res.status(500).json({
      error: 'Failed to create container',
      details: error.response ? error.response.data : 'No additional error info'
    });
  }
});

async function prepareRequestData(image, memory, cpu, ports, name, node) {
  const rawImage = await db.get('images');
  const imageData = rawImage.find(i => i.Image === image);

  const requestData = {
    method: 'post',
    url: `http://${node.address}:${node.port}/instances/create`,
    auth: {
      username: 'Skyport',
      password: node.apiKey
    },
    headers: { 
      'Content-Type': 'application/json'
    },
    data: {
      Name: name,
      Image: image,
      Env: imageData ? imageData.Env : undefined,
      Scripts: imageData ? imageData.Scripts : undefined,
      Memory: memory ? parseInt(memory) : undefined,
      Cpu: cpu ? parseInt(cpu) : undefined,
      ExposedPorts: {},
      PortBindings: {}
    }
  };

  if (ports) {
    ports.split(',').forEach(portMapping => {
      const [containerPort, hostPort] = portMapping.split(':');
      const key = `${containerPort}/tcp`;
      requestData.data.ExposedPorts[key] = {};
      requestData.data.PortBindings[key] = [{ HostPort: hostPort }];
    });
  }

  return requestData;
}

async function updateDatabaseWithNewInstance(responseData, userId, node, image, memory, cpu, ports, primary, name) {
  const instanceData = {
    Name: name,
    Node: node,
    User: userId,
    ContainerId: responseData.containerId,
    VolumeId: responseData.volumeId,
    Memory: parseInt(memory),
    Cpu: parseInt(cpu),
    Ports: ports,
    Primary: primary,
    Image: image
  };

  const userInstances = await db.get(`${userId}_instances`) || [];
  userInstances.push(instanceData);
  await db.set(`${userId}_instances`, userInstances);

  const globalInstances = await db.get('instances') || [];
  globalInstances.push(instanceData);
  await db.set('instances', globalInstances);

  await db.set(`${responseData.containerId}_instance`, instanceData);
}

module.exports = router;