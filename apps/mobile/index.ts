// App entry. The handover push task must be defined before anything else runs:
// when a silent push starts the app with no UI, this module is all that loads
// before the task is called (spec/05 § Handover).
import { defineHandoverTask } from './src/lib/handover';

defineHandoverTask();

// eslint-disable-next-line import/first
import 'expo-router/entry';
