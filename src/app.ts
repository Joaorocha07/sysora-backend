import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { apiRateLimiter } from './middlewares/rateLimit.middleware';
import { requireSchema, schemaState } from './lib/schemaGuard';
import { accountRouter } from './modules/account/account.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { appointmentsRouter } from './modules/appointments/appointments.routes';
import { bookingRouter } from './modules/booking/booking.routes';
import { authRouter } from './modules/auth/auth.routes';
import { clientsRouter } from './modules/clients/clients.routes';
import { clientSubscriptionsRouter } from './modules/clientSubscriptions/clientSubscriptions.routes';
import { conversationsRouter } from './modules/conversations/conversations.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { emailCodesRouter } from './modules/emailCodes/emailCodes.routes';
import { servicesRouter } from './modules/services/services.routes';
import { settingsRouter } from './modules/settings/settings.routes';
import { soraRouter } from './modules/sora/sora.routes';
import { usersRouter } from './modules/users/users.routes';
import { subscriptionsRouter } from './modules/subscriptions/subscriptions.routes';
import { privacyRouter } from './modules/privacy/privacy.routes';
import { surveyRouter } from './modules/survey/survey.routes';
import { webhooksRouter } from './modules/webhooks/webhooks.routes';
import { whatsappRouter } from './modules/whatsapp/whatsapp.routes';

export const app = express();

app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
app.disable('x-powered-by');
app.use(helmet());
const allowedOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim());
app.use(cors({
  // Em desenvolvimento aceita qualquer porta do localhost (o Next muda de
  // porta quando a 3000 está ocupada).
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)
    || (env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))),
  credentials: true,
}));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if ((req as express.Request).originalUrl?.startsWith('/api/webhooks/whatsapp')) (req as express.Request).rawBody = buf;
  },
}));
app.use(cookieParser());
app.use(morgan(env.NODE_ENV === 'development' ? 'dev' : 'combined'));
app.use(apiRateLimiter);

app.get('/health', (_req, res) => res.json({ status: 'ok', database: schemaState.ok ? 'ok' : 'out_of_date' }));
// Para monitoramento: 503 enquanto houver migration pendente.
app.get('/health/db', (_req, res) => res.status(schemaState.ok ? 200 : 503).json({ ok: schemaState.ok, pending: schemaState.pending, checkedAt: schemaState.checkedAt }));

app.use('/api', requireSchema);

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/account', accountRouter);
app.use('/api/users', usersRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/client-subscriptions', clientSubscriptionsRouter);
app.use('/api/services', servicesRouter);
app.use('/api/appointments', appointmentsRouter);
// Página pública do link de agendamento (sem login).
app.use('/api/booking', bookingRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/survey', surveyRouter);
app.use('/api/privacy', privacyRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/email-codes', emailCodesRouter);
app.use('/api/sora', soraRouter);

app.use(notFoundHandler);
app.use(errorHandler);
