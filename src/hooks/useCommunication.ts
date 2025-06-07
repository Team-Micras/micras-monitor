import { CommunicationContext } from '@/contexts/CommunicationContext';
import { useContext } from 'react';

export const useCommunication = () => {
  const context = useContext(CommunicationContext);
  if (!context) {
    throw new Error('useCommunication must be used within a CommunicationProvider');
  }
  return context;
};
