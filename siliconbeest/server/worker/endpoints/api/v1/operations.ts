import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authOptional } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';
import { getWriteOperation } from '../../../services/writeJournal';
import { getRegistrationOperation } from '../../../services/asyncRegistration';
import { isValidUlid } from '../../../utils/ulid';

const operations = new Hono<{ Variables: AppVariables }>();

operations.get('/:id', authOptional, async (c) => {
  const operationId = c.req.param('id');
  if (!isValidUlid(operationId)) throw new AppError(404, 'Operation not found');
  const registration = await getRegistrationOperation(operationId);
  if (registration) {
    return c.json({
      operationId: registration.operationId,
      state: registration.state,
      attempts: registration.attempts,
      acceptedAt: registration.acceptedAt,
      updatedAt: registration.updatedAt,
      error: registration.state === 'failed' ? registration.error : null,
    });
  }
  const accountId = c.get('currentUser')?.account_id;
  if (!accountId) throw new AppError(401, 'The access token is invalid');
  const operation = await getWriteOperation(accountId, operationId);
  if (!operation) throw new AppError(404, 'Operation not found');
  return c.json(operation);
});

export default operations;
