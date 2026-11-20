package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;
import static io.github.imetaxas.realitycheck.RealityAssertions.assertThatThrownBy;

import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.exception.BudgetExceededException;
import com.yanimetaxas.bookkeeping.model.Money;
import com.yanimetaxas.bookkeeping.service.BudgetService;
import org.junit.jupiter.api.Test;

/** Frozen acceptance checks for R5: a per-account budget for one accounting period. */
class R5AcceptanceTest {

  @Test
  void debitsAccumulateWithinThePeriod() {
    Ledger ledger = AcceptanceSupport.ledger("r5-accumulate", "1000.00");
    BudgetService budgets = ledger.budgetService();
    budgets.setBudget("CASH", AcceptanceSupport.PERIOD, Money.toMoney("100.00", "EUR"));

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "60.00"));

    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", AcceptanceSupport.PERIOD), "60.00");
    AcceptanceSupport.assertAmount(budgets.getBudget("CASH", AcceptanceSupport.PERIOD), "100.00");
  }

  @Test
  void exceedingTheBudgetRejectsTheWholeTransfer() {
    Ledger ledger = AcceptanceSupport.ledger("r5-exceeded", "1000.00");
    BudgetService budgets = ledger.budgetService();
    budgets.setBudget("CASH", AcceptanceSupport.PERIOD, Money.toMoney("100.00", "EUR"));
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "60.00"));

    assertThatThrownBy(() -> ledger.commit(AcceptanceSupport.payment(ledger, "T2", "60.00")))
        .isInstanceOf(BudgetExceededException.class);

    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", AcceptanceSupport.PERIOD), "60.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "940.00");
    assertThat(ledger.getTransactionByRef("T2")).isNull();
  }

  @Test
  void reachingTheBudgetExactlyIsAllowed() {
    Ledger ledger = AcceptanceSupport.ledger("r5-exact", "1000.00");
    BudgetService budgets = ledger.budgetService();
    budgets.setBudget("CASH", AcceptanceSupport.PERIOD, Money.toMoney("100.00", "EUR"));

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "60.00"));
    ledger.commit(AcceptanceSupport.payment(ledger, "T2", "40.00"));

    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", AcceptanceSupport.PERIOD), "100.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "900.00");
  }

  @Test
  void budgetsAreCheckedPerAccount() {
    Ledger ledger = AcceptanceSupport.ledger("r5-per-account", "1000.00");
    BudgetService budgets = ledger.budgetService();
    budgets.setBudget("CASH", AcceptanceSupport.PERIOD, Money.toMoney("100.00", "EUR"));

    ledger.commit(AcceptanceSupport.debitFrom(ledger, "T1", "REVENUE", "CASH", "500.00"));

    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", AcceptanceSupport.PERIOD), "0.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "1500.00");
  }

  @Test
  void anAccountWithoutBudgetIsNotRestricted() {
    Ledger ledger = AcceptanceSupport.ledger("r5-unset", "1000.00");
    BudgetService budgets = ledger.budgetService();

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "900.00"));

    assertThat(budgets.getBudget("CASH", AcceptanceSupport.PERIOD)).isNull();
    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", AcceptanceSupport.PERIOD), "900.00");
  }

  @Test
  void anotherPeriodHasItsOwnAccumulation() {
    Ledger ledger = AcceptanceSupport.ledger("r5-periods", "1000.00");
    BudgetService budgets = ledger.budgetService();
    budgets.setBudget("CASH", AcceptanceSupport.PERIOD, Money.toMoney("100.00", "EUR"));

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "60.00"));

    AcceptanceSupport.assertAmount(budgets.getBudgetUsed("CASH", "2026-02"), "0.00");
    assertThat(budgets.getBudget("CASH", "2026-02")).isNull();
  }
}
