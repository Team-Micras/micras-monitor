import type { Variable } from '@/types/variable';
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { memo } from 'react';
import { useVariableValue } from '@/hooks/useVariableValue';

interface VariableCardProps {
  variable: Variable;
}

export const VariableCard = memo(
  function VariableCard({ variable }: VariableCardProps) {
    const serialVariableRef = variable.serialVariable.value;
    const { value, name, type } = useVariableValue(serialVariableRef, variable.id);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{name}</CardTitle>
          <CardDescription>{type}</CardDescription>
          <CardAction>{value.toString()}</CardAction>
        </CardHeader>
      </Card>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.variable.id === nextProps.variable.id &&
      prevProps.variable.isEnabled === nextProps.variable.isEnabled &&
      prevProps.variable.color === nextProps.variable.color
    );
  }
);
