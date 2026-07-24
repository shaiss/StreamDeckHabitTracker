# Seeing your data

Every tap adds a row to the **Log** tab (created automatically on the first tap):
`Timestamp | Habit | Date | Time | Note`.

A few easy ways to make sense of it.

## Totals per habit
New tab → cell **A1**:

```
=QUERY(Log!A:B, "select B, count(B) where B is not null group by B label count(B) 'Count'", 1)
```

## Today only
```
=QUERY(Log!A:E, "select B, count(B) where C = '"&TEXT(TODAY(),"yyyy-mm-dd")&"' group by B label count(B) 'Today'", 1)
```

## Last 7 days, per day per habit (pivot-style)
```
=QUERY(Log!A:E, "select C, B, count(B) where C >= '"&TEXT(TODAY()-6,"yyyy-mm-dd")&"' group by C, B order by C", 1)
```

## Or just a Pivot Table
Insert → Pivot table → Rows: **Habit**, Values: **count of Habit**. Add **Date** as a
column or filter for per-day views.

## Chart
Select the QUERY output → Insert → Chart → Column chart.

> Tip: the sheet lives in your Drive, so you can open and check it from your phone anytime.
